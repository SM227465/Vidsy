// Live HLS recording. Unlike VOD (fixed segment list → fetch once → mux), a live
// media playlist is a sliding window: poll it on an interval, append only the
// newly-appeared segments (deduped by media sequence) to one OPFS accumulator,
// and mux that file → MP4/MP3 when the user hits Stop. Plan:
// ~/.claude/plans/live-hls-recording.md.

import { registerOutputForCleanup } from './blob-cleanup';
import { mp3TranscodeArgs, resolveVariantPlaylist } from './hls-download';
import { jsfetchInputForOpfs, preflightDiskSpace } from './libav-mux';
import { isLivePlaylist, parseHlsPlaylist } from './m3u8-parser';
import { clearProgress, updateProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import { swLog } from './sw-log';
import { appendSegmentsToOpfs, cancelWorkerJob, getOpfsFile, muxInWorker, removeOpfs } from './worker-client';

type RecorderArgs = {
  playlistUrl: string;
  fileName: string;
  output: 'mp4' | 'mp3';
  key: string;
  headers?: Record<string, string>;
};

type RecordingHandle = {
  key: string;
  // Stop = finalize (mux what we have). Abort = discard. Both end the poll loop.
  stopRequested: boolean;
  aborted: boolean;
  // Pause = keep polling so we stay at the live edge, but stop appending; Resume
  // continues from "now" (the paused span is skipped — inherent to live capture).
  paused: boolean;
  // Resolves to the muxed blob on Stop, or null when aborted/discarded; rejects
  // on a fatal recording error.
  done: Promise<{ blobUrl: string; ext: string } | null>;
};

const activeRecordings = new Map<string, RecordingHandle>();

const liveOpfsName = (key: string, tag: string, ext: string): string =>
  `live-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}-${Date.now().toString(36)}.${ext}`;

// Remux args for a live recording → MP4. Live segments (TS or fMP4) carry the
// broadcast's continuous timeline, so a plain stream-copy yields an MP4 whose
// duration reflects that timeline (hours), not the captured span. `+genpts`
// regenerates missing PTS and `-avoid_negative_ts make_zero` re-bases the first
// timestamp to 0, so the muxed file's duration is the actual recording length.
const liveMp4MuxArgs = (input: string, output: string): string[] => [
  '-fflags',
  '+genpts',
  '-i',
  input,
  '-c',
  'copy',
  '-avoid_negative_ts',
  'make_zero',
  '-y',
  output,
];

// Cooperative sleep that wakes early on stop/abort, so Stop latency is bounded by
// STEP_MS rather than the (multi-second) playlist reload interval.
const STEP_MS = 250;
const interruptibleSleep = async (ms: number, handle: RecordingHandle, signal: AbortSignal): Promise<void> => {
  const until = Date.now() + ms;
  // React to a pause/resume *toggle* (not state) so the loop top can update the
  // stage within STEP_MS — but a still-paused sleep runs its full term, so we
  // never hot-loop while paused.
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
  const { key, output, headers } = args;
  const stopping = () => handle.stopRequested || handle.aborted || abortController.signal.aborted;
  let inputOpfsName: string | null = null;
  let recordedBytes = 0;

  try {
    swLog('REC: start', { key, playlistUrl: args.playlistUrl });
    // Stay in the 'recording' stage from the very start so the content-UI pill
    // shows the REC / Pause / Stop controls immediately, rather than flashing the
    // "Downloading…" download pill during manifest resolution.
    await updateProgress(key, { stage: 'recording', downloadedBytes: 0 });
    const { url: mediaUrl, manifestText } = await resolveVariantPlaylist(args.playlistUrl, abortController.signal);
    let parsed = parseHlsPlaylist(manifestText, mediaUrl);
    swLog('REC: manifest resolved', {
      mediaUrl,
      isLive: isLivePlaylist(parsed),
      endList: parsed.endList,
      segments: parsed.segments.length,
      isFmp4: Boolean(parsed.mapUrl),
    });

    if (!isLivePlaylist(parsed)) {
      throw new Error('This stream is not live — use Download instead.');
    }

    const isFmp4 = Boolean(parsed.mapUrl);
    inputOpfsName = liveOpfsName(key, 'in', isFmp4 ? 'mp4' : 'ts');
    let initSent = false;
    let lastSeq = -1;
    let wasPaused = false;

    await updateProgress(key, { stage: 'recording', downloadedBytes: 0 });

    while (!stopping()) {
      if (handle.paused) {
        // While paused, keep the loop alive at the live edge: skip appends and
        // advance lastSeq to the newest segment so Resume picks up from "now".
        if (!wasPaused) {
          wasPaused = true;
          await updateProgress(key, { stage: 'recording-paused', downloadedBytes: recordedBytes });
        }
        const latest = parsed.segments[parsed.segments.length - 1]?.sequenceNumber;
        if (latest !== undefined) lastSeq = latest;
      } else {
        if (wasPaused) {
          wasPaused = false;
          await updateProgress(key, { stage: 'recording', downloadedBytes: recordedBytes });
        }
        const fresh = parsed.segments.filter(s => s.sequenceNumber > lastSeq);
        // Append one segment at a time so a single bad segment (rolled off the
        // live window, transient 403, expired token) can be skipped without
        // killing the whole recording — a long live capture must be resilient.
        for (const seg of fresh) {
          if (stopping() || handle.paused) break;
          try {
            const { totalBytes } = await appendSegmentsToOpfs({
              jobKey: key,
              opfsName: inputOpfsName,
              segments: [{ url: seg.url, keyInfo: seg.keyInfo, sequenceNumber: seg.sequenceNumber }],
              initUrl: !initSent && isFmp4 ? parsed.mapUrl : undefined,
              keyHeaders: headers,
            });
            initSent = true;
            recordedBytes = totalBytes;
            lastSeq = seg.sequenceNumber;
            await updateProgress(key, { stage: 'recording', downloadedBytes: recordedBytes });
          } catch (err) {
            if (abortController.signal.aborted) throw err;
            // Advance past the failed segment (accept a small gap) and keep going.
            lastSeq = seg.sequenceNumber;
            swLog('REC: segment skipped', {
              seq: seg.sequenceNumber,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (parsed.endList) break; // stream signalled its own end

      // Reload pacing (RFC 8216 §6.3.4): targetDuration, halved after a poll that
      // produced no new segments. Floor at 1s so we never hot-loop.
      const target = (parsed.targetDuration ?? 6) * 1000;
      const hadNew = !handle.paused && parsed.segments.some(s => s.sequenceNumber > lastSeq);
      await interruptibleSleep(Math.max(1000, hadNew ? target : target / 2), handle, abortController.signal);
      if (stopping()) break;

      try {
        const res = await fetch(mediaUrl, { credentials: 'include', signal: abortController.signal });
        if (!res.ok) continue; // transient server error — keep what we have, retry next poll
        parsed = parseHlsPlaylist(await res.text(), mediaUrl);
      } catch {
        if (abortController.signal.aborted) break;
        continue; // network blip — skip this poll, keep recording
      }
    }

    // Abort / hard-cancel = discard the partial recording.
    if (handle.aborted || abortController.signal.aborted) {
      if (inputOpfsName) void removeOpfs(inputOpfsName).catch(() => undefined);
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
      return null;
    }

    if (lastSeq < 0) throw new Error('Stopped before any segments were recorded.');

    // Finalize: mux the accumulator → MP4/MP3 (mirrors the HLS auth-fallback tail).
    await updateProgress(key, { stage: 'mux', downloadedBytes: recordedBytes });

    // Even fMP4 is remuxed through libav (not handed off raw): live segment
    // timestamps would otherwise give the MP4 a wildly wrong duration. See
    // liveMp4MuxArgs (re-bases the timeline to start at 0).
    const outputOpfsName = liveOpfsName(key, 'out', output === 'mp3' ? 'mp3' : 'mp4');
    await preflightDiskSpace(recordedBytes);
    const { jsfetchUrl, blobUrl: inputBlobUrl } = await jsfetchInputForOpfs(inputOpfsName);
    try {
      const ffmpegArgs =
        output === 'mp3' ? mp3TranscodeArgs(jsfetchUrl, outputOpfsName) : liveMp4MuxArgs(jsfetchUrl, outputOpfsName);
      await muxInWorker({
        jobKey: key,
        outputOpfsName,
        ffmpegArgs,
        estimatedBytes: output === 'mp3' ? undefined : recordedBytes,
      });
    } finally {
      URL.revokeObjectURL(inputBlobUrl);
    }
    void removeOpfs(inputOpfsName).catch(() => undefined);
    inputOpfsName = null;

    const outputFile = await getOpfsFile(outputOpfsName);
    const blobUrl = URL.createObjectURL(outputFile);
    registerOutputForCleanup(blobUrl, outputOpfsName);
    await clearProgress(key);
    return { blobUrl, ext: output === 'mp3' ? '.mp3' : '.mp4' };
  } catch (err) {
    if (inputOpfsName) void removeOpfs(inputOpfsName).catch(() => undefined);
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

export const startLiveRecording = (args: RecorderArgs): void => {
  if (activeRecordings.has(args.key)) return;
  const abortController = new AbortController();
  // Register under the shared map so the existing offscreen/cancel path (hard
  // cancel) aborts an in-flight recording the same way it cancels a download.
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
    cancelWorkerJob(args.key); // abort any append in flight inside the worker
  });
  handle.done = runRecordingLoop(args, handle, abortController);
  // Attach a no-op catch so a fatal recording error (when the user never calls
  // Stop) doesn't surface as an unhandled rejection. Stop/abort callers still
  // observe the outcome via their own await of `done`.
  handle.done.catch(() => undefined);
  activeRecordings.set(args.key, handle);
};

export const pauseLiveRecording = (key: string): void => {
  const handle = activeRecordings.get(key);
  if (handle) handle.paused = true;
};

export const resumeLiveRecording = (key: string): void => {
  const handle = activeRecordings.get(key);
  if (handle) handle.paused = false;
};

export const stopLiveRecording = async (key: string): Promise<{ blobUrl: string; ext: string } | null> => {
  const handle = activeRecordings.get(key);
  if (!handle) return null;
  handle.paused = false; // ensure the loop runs to the finalize tail
  handle.stopRequested = true;
  return handle.done;
};

export const abortLiveRecording = async (key: string): Promise<void> => {
  const handle = activeRecordings.get(key);
  if (!handle) return;
  handle.aborted = true;
  await handle.done.catch(() => undefined);
};
