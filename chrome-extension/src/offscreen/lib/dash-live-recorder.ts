// Live DASH recording. Sibling to hls-live-recorder, but a live DASH MPD is
// dynamic: poll it on an interval, and for BOTH the video and audio tracks append
// only the newly-appeared CMAF segments (deduped by their $Time$-substituted URL)
// to two OPFS accumulators, then mux the pair → MP4 on Stop. VK live (okcdn.ru)
// uses this: application/dash+xml + separate audio/mp4 + video/mp4 segments.

import { registerOutputForCleanup } from './blob-cleanup';
import { fetchMpdText, parseDashSegments } from './dash-download';
import { jsfetchInputForOpfs, preflightDiskSpace } from './libav-mux';
import { clearProgress, updateProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import { swLog } from './sw-log';
import { appendSegmentsToOpfs, cancelWorkerJob, getOpfsFile, muxInWorker, removeOpfs } from './worker-client';

type RecorderArgs = {
  manifestUrl: string;
  fileName: string;
  output: 'mp4' | 'mp3';
  key: string;
  headers?: Record<string, string>;
};

type RecordingHandle = {
  key: string;
  stopRequested: boolean;
  aborted: boolean;
  paused: boolean;
  done: Promise<{ blobUrl: string; ext: string } | null>;
};

const activeRecordings = new Map<string, RecordingHandle>();

const liveOpfsName = (key: string, tag: string, ext: string): string =>
  `dashlive-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}-${Date.now().toString(36)}.${ext}`;

// Live segments carry the broadcast's continuous timeline, so a plain stream-copy
// would give the MP4 a wildly wrong duration. +genpts regenerates PTS and
// make_zero re-bases the first timestamp to 0 → the file's duration is the
// captured span. Mux the separate video + audio accumulators into one MP4.
const liveMuxArgs = (videoUrl: string, audioUrl: string, output: string): string[] => [
  '-fflags',
  '+genpts',
  '-i',
  videoUrl,
  '-i',
  audioUrl,
  '-map',
  '0:v:0',
  '-map',
  '1:a:0?',
  '-c',
  'copy',
  '-avoid_negative_ts',
  'make_zero',
  '-y',
  output,
];

const liveVideoOnlyMuxArgs = (videoUrl: string, output: string): string[] => [
  '-fflags',
  '+genpts',
  '-i',
  videoUrl,
  '-c',
  'copy',
  '-avoid_negative_ts',
  'make_zero',
  '-y',
  output,
];

const liveAudioMp3Args = (audioUrl: string, output: string): string[] => [
  '-i',
  audioUrl,
  '-vn',
  '-c:a',
  'libmp3lame',
  '-q:a',
  '2',
  '-y',
  output,
];

const STEP_MS = 250;
const interruptibleSleep = async (ms: number, handle: RecordingHandle, signal: AbortSignal): Promise<void> => {
  const until = Date.now() + ms;
  const pausedAtStart = handle.paused;
  while (Date.now() < until) {
    if (handle.stopRequested || handle.aborted || signal.aborted) return;
    if (handle.paused !== pausedAtStart) return;
    await new Promise(r => setTimeout(r, Math.min(STEP_MS, until - Date.now())));
  }
};

const runRecordingLoop = async (
  args: RecorderArgs,
  handle: RecordingHandle,
  abortController: AbortController,
): Promise<{ blobUrl: string; ext: string } | null> => {
  const { key, output, headers, manifestUrl } = args;
  const stopping = () => handle.stopRequested || handle.aborted || abortController.signal.aborted;

  // A resolution-picker variant arrives as `<mpd>#h=<height>`.
  const heightMatch = /[#&]h=(\d+)/.exec(manifestUrl);
  const targetHeight = heightMatch ? Number(heightMatch[1]) : undefined;
  const cleanUrl = manifestUrl.split('#')[0];

  const videoOpfs = liveOpfsName(key, 'v', 'mp4');
  const audioOpfs = liveOpfsName(key, 'a', 'mp4');
  const appendedVideo = new Set<string>();
  const appendedAudio = new Set<string>();
  let videoInitSent = false;
  let audioInitSent = false;
  let totalBytes = 0;
  let videoBytes = 0;
  let audioBytes = 0;
  let seq = 0;
  let wasPaused = false;
  const cleanupInputs = () => {
    void removeOpfs(videoOpfs).catch(() => undefined);
    void removeOpfs(audioOpfs).catch(() => undefined);
  };

  try {
    swLog('DASHREC: start', { key, manifestUrl: cleanUrl, targetHeight });
    await updateProgress(key, { stage: 'recording', downloadedBytes: 0 });

    let pollMs = 4000;
    while (!stopping()) {
      let tracks: ReturnType<typeof parseDashSegments> | null = null;
      try {
        const xml = await fetchMpdText(cleanUrl, abortController.signal);
        tracks = parseDashSegments(xml, cleanUrl, targetHeight);
      } catch {
        if (abortController.signal.aborted) break;
        await interruptibleSleep(pollMs, handle, abortController.signal);
        continue;
      }
      // Pace polling at roughly one segment duration (we don't have it precisely;
      // 4s is a safe default for CMAF live, floored so we never hot-loop).
      pollMs = 4000;

      if (handle.paused) {
        if (!wasPaused) {
          wasPaused = true;
          await updateProgress(key, { stage: 'recording-paused', downloadedBytes: totalBytes });
        }
        // Mark the current window as seen so Resume continues from "now" (the
        // paused span is skipped — inherent to live capture).
        tracks.video?.segmentUrls.forEach(u => appendedVideo.add(u));
        tracks.audio?.segmentUrls.forEach(u => appendedAudio.add(u));
        await interruptibleSleep(pollMs, handle, abortController.signal);
        continue;
      }
      if (wasPaused) {
        wasPaused = false;
        await updateProgress(key, { stage: 'recording', downloadedBytes: totalBytes });
      }

      // Append new segments, one at a time, so a single bad segment (rolled off
      // the window, expired token) is skipped without killing the recording.
      // setBytes records the per-file cumulative size so combined progress is
      // accurate (appendSegmentsToOpfs returns the running total for ITS file).
      const pump = async (
        track: { initUrl?: string; segmentUrls: string[] } | undefined,
        opfsName: string,
        appended: Set<string>,
        initSent: boolean,
        setBytes: (n: number) => void,
      ): Promise<boolean> => {
        if (!track) return initSent;
        const fresh = track.segmentUrls.filter(u => !appended.has(u));
        for (const url of fresh) {
          if (stopping() || handle.paused) break;
          try {
            const res = await appendSegmentsToOpfs({
              jobKey: key,
              opfsName,
              segments: [{ url, sequenceNumber: seq++ }],
              initUrl: !initSent ? track.initUrl : undefined,
              keyHeaders: headers,
            });
            initSent = true;
            appended.add(url);
            setBytes(res.totalBytes);
          } catch (err) {
            if (abortController.signal.aborted) throw err;
            appended.add(url); // accept a small gap, keep going
            swLog('DASHREC: segment skipped', { err: err instanceof Error ? err.message : String(err) });
          }
        }
        return initSent;
      };
      videoInitSent = await pump(tracks.video, videoOpfs, appendedVideo, videoInitSent, n => (videoBytes = n));
      audioInitSent = await pump(tracks.audio, audioOpfs, appendedAudio, audioInitSent, n => (audioBytes = n));
      totalBytes = videoBytes + audioBytes;
      await updateProgress(key, { stage: 'recording', downloadedBytes: totalBytes });

      swLog('DASHREC: poll', { video: appendedVideo.size, audio: appendedAudio.size, bytes: totalBytes });
      await interruptibleSleep(pollMs, handle, abortController.signal);
    }

    if (handle.aborted || abortController.signal.aborted) {
      cleanupInputs();
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
      return null;
    }

    if (appendedVideo.size === 0 && appendedAudio.size === 0) {
      throw new Error('Stopped before any segments were recorded.');
    }

    await updateProgress(key, { stage: 'mux', downloadedBytes: totalBytes });
    await preflightDiskSpace(totalBytes);

    const outputOpfs = liveOpfsName(key, 'out', output === 'mp3' ? 'mp3' : 'mp4');
    const haveVideo = appendedVideo.size > 0;
    const haveAudio = appendedAudio.size > 0;
    const v = haveVideo ? await jsfetchInputForOpfs(videoOpfs) : null;
    const a = haveAudio ? await jsfetchInputForOpfs(audioOpfs) : null;
    try {
      let ffmpegArgs: string[];
      if (output === 'mp3' && a) {
        ffmpegArgs = liveAudioMp3Args(a.jsfetchUrl, outputOpfs);
      } else if (v && a) {
        ffmpegArgs = liveMuxArgs(v.jsfetchUrl, a.jsfetchUrl, outputOpfs);
      } else {
        ffmpegArgs = liveVideoOnlyMuxArgs((v ?? a)!.jsfetchUrl, outputOpfs);
      }
      await muxInWorker({ jobKey: key, outputOpfsName: outputOpfs, ffmpegArgs, estimatedBytes: totalBytes });
    } finally {
      if (v) URL.revokeObjectURL(v.blobUrl);
      if (a) URL.revokeObjectURL(a.blobUrl);
    }
    cleanupInputs();

    const outputFile = await getOpfsFile(outputOpfs);
    const blobUrl = URL.createObjectURL(outputFile);
    registerOutputForCleanup(blobUrl, outputOpfs);
    await clearProgress(key);
    return { blobUrl, ext: output === 'mp3' ? '.mp3' : '.mp4' };
  } catch (err) {
    cleanupInputs();
    await updateProgress(key, {
      stage: 'failed',
      downloadedBytes: 0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    activeRecordings.delete(key);
  }
};

const startDashLiveRecording = (args: RecorderArgs): void => {
  if (activeRecordings.has(args.key)) return;
  const abortController = new AbortController();
  activeAbortControllers.set(args.key, abortController);
  const handle: RecordingHandle = {
    key: args.key,
    stopRequested: false,
    aborted: false,
    paused: false,
    done: Promise.resolve(null),
  };
  abortController.signal.addEventListener('abort', () => {
    handle.aborted = true;
    cancelWorkerJob(args.key);
  });
  handle.done = runRecordingLoop(args, handle, abortController);
  handle.done.catch(() => undefined);
  activeRecordings.set(args.key, handle);
};

const pauseDashLiveRecording = (key: string): void => {
  const handle = activeRecordings.get(key);
  if (handle) handle.paused = true;
};

const resumeDashLiveRecording = (key: string): void => {
  const handle = activeRecordings.get(key);
  if (handle) handle.paused = false;
};

const stopDashLiveRecording = async (key: string): Promise<{ blobUrl: string; ext: string } | null> => {
  const handle = activeRecordings.get(key);
  if (!handle) return null;
  handle.paused = false;
  handle.stopRequested = true;
  return handle.done;
};

const abortDashLiveRecording = async (key: string): Promise<void> => {
  const handle = activeRecordings.get(key);
  if (!handle) return;
  handle.aborted = true;
  await handle.done.catch(() => undefined);
};

export {
  startDashLiveRecording,
  pauseDashLiveRecording,
  resumeDashLiveRecording,
  stopDashLiveRecording,
  abortDashLiveRecording,
};
