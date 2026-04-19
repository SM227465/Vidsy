import { registerOutputForCleanup } from './blob-cleanup';
import {
  dashManifestDurationSeconds,
  jsfetchInputForOpfs,
  jsfetchInputForUrl,
  needsAuthFallback,
  preflightDiskSpace,
} from './libav-mux';
import { updateProgress, clearProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import { cancelWorkerJob, fetchSegmentsToOpfs, getOpfsFile, muxInWorker, removeOpfs } from './worker-client';

const opfsNameFor = (key: string, tag: string, ext: string): string =>
  `dash-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}-${Date.now().toString(36)}.${ext}`;

// ─── DASH types ───

type DashSegmentInfo = {
  initUrl?: string;
  segmentUrls: string[];
};

type DashTrackSet = {
  video?: DashSegmentInfo;
  audio?: DashSegmentInfo;
};

// ─── DASH parsing ───

const parseIsoDuration = (iso: string): number => {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
};

const parseDashSegmentTemplate = (
  template: Element,
  rep: Element,
  manifestUrl: string,
): DashSegmentInfo | undefined => {
  const initTpl = template.getAttribute('initialization') ?? '';
  const mediaTpl = template.getAttribute('media') ?? '';
  const repId = rep.getAttribute('id') ?? '';
  const bandwidth = rep.getAttribute('bandwidth') ?? '';

  const replaceTpl = (tpl: string, vars: Record<string, string>) => {
    let result = tpl;
    for (const [k, v] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\$${k}\\$`, 'g'), v);
    }
    return result;
  };
  const tplVars = { RepresentationID: repId, Bandwidth: bandwidth };
  const initUrl = initTpl ? new URL(replaceTpl(initTpl, tplVars), manifestUrl).toString() : undefined;
  const segmentUrls: string[] = [];

  const timeline = template.querySelector('SegmentTimeline');
  if (timeline) {
    let time = 0;
    for (const s of Array.from(timeline.querySelectorAll('S'))) {
      const t = s.getAttribute('t');
      if (t) time = Number(t);
      const d = Number(s.getAttribute('d') ?? '0');
      const r = Number(s.getAttribute('r') ?? '0');
      for (let i = 0; i <= r; i++) {
        const url = replaceTpl(mediaTpl, { ...tplVars, Time: String(time), Number: String(segmentUrls.length + 1) });
        segmentUrls.push(new URL(url, manifestUrl).toString());
        time += d;
      }
    }
  } else {
    const startNumber = Number(template.getAttribute('startNumber') ?? '1');
    const duration = Number(template.getAttribute('duration') ?? '0');
    const timescale = Number(template.getAttribute('timescale') ?? '1');
    if (duration <= 0) return undefined;
    const period = template.closest('Period');
    const mpd = template.closest('MPD');
    const periodDur = period?.getAttribute('duration') ?? mpd?.getAttribute('mediaPresentationDuration') ?? '';
    const totalSeconds = parseIsoDuration(periodDur);
    if (totalSeconds <= 0) return undefined;
    const segCount = Math.ceil(totalSeconds / (duration / timescale));
    for (let i = 0; i < segCount; i++) {
      const url = replaceTpl(mediaTpl, { ...tplVars, Number: String(startNumber + i) });
      segmentUrls.push(new URL(url, manifestUrl).toString());
    }
  }

  return { initUrl, segmentUrls };
};

const parseDashSegmentList = (segList: Element, manifestUrl: string): DashSegmentInfo => {
  const initEl = segList.querySelector('Initialization');
  const initUrl = initEl?.getAttribute('sourceURL')
    ? new URL(initEl.getAttribute('sourceURL')!, manifestUrl).toString()
    : undefined;
  const segmentUrls = Array.from(segList.querySelectorAll('SegmentURL'))
    .map(el => el.getAttribute('media'))
    .filter((u): u is string => Boolean(u))
    .map(u => new URL(u, manifestUrl).toString());
  return { initUrl, segmentUrls };
};

const extractDashSegmentUrls = (
  rep: Element,
  adaptationSet: Element,
  manifestUrl: string,
): DashSegmentInfo | undefined => {
  const template = rep.querySelector('SegmentTemplate') ?? adaptationSet.querySelector('SegmentTemplate');
  if (template) return parseDashSegmentTemplate(template, rep, manifestUrl);
  const segList = rep.querySelector('SegmentList') ?? adaptationSet.querySelector('SegmentList');
  if (segList) return parseDashSegmentList(segList, manifestUrl);
  return undefined;
};

const fetchMpdText = async (manifestUrl: string): Promise<string> => {
  const res = await fetch(manifestUrl, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch DASH manifest: ${res.status}`);
  return res.text();
};

// Parses BOTH tracks. Only used by the auth-fallback branch — the direct
// path hands the MPD URL to libav and lets it demux natively.
const parseDashSegments = (xml: string, manifestUrl: string): DashTrackSet => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const result: DashTrackSet = {};
  for (const as of Array.from(doc.querySelectorAll('AdaptationSet'))) {
    const contentType = as.getAttribute('contentType') ?? as.getAttribute('mimeType') ?? '';
    const isVideo = contentType.includes('video');
    const isAudio = contentType.includes('audio');
    if (!isVideo && !isAudio) continue;
    const trackName = isVideo ? 'video' : 'audio';
    if (result[trackName]) continue;

    const reps = Array.from(as.querySelectorAll('Representation'));
    if (reps.length === 0) continue;
    const bestRep = reps.reduce((best, rep) => {
      const bw = Number(rep.getAttribute('bandwidth') ?? '0');
      const bestBw = Number(best.getAttribute('bandwidth') ?? '0');
      return bw > bestBw ? rep : best;
    });

    const segmentInfo = extractDashSegmentUrls(bestRep, as, manifestUrl);
    if (segmentInfo && segmentInfo.segmentUrls.length > 0) {
      result[trackName] = segmentInfo;
    }
  }
  return result;
};

// ─── ffmpeg argv builders ───

const mp4StreamCopyArgs = (input: string, output: string): string[] => ['-i', input, '-c', 'copy', '-y', output];

const mp3TranscodeArgs = (input: string, output: string): string[] => [
  '-i',
  input,
  '-vn',
  '-c:a',
  'libmp3lame',
  '-q:a',
  '2',
  '-y',
  output,
];

const dashMp4MuxArgs = (jsfetchUrl: string, output: string): string[] => [
  '-f',
  'dash',
  '-i',
  jsfetchUrl,
  '-map',
  '0:v:0',
  '-map',
  '0:a:0?',
  '-c',
  'copy',
  '-y',
  output,
];

const dashMp3TranscodeArgs = (jsfetchUrl: string, output: string): string[] => [
  '-f',
  'dash',
  '-i',
  jsfetchUrl,
  '-vn',
  '-c:a',
  'libmp3lame',
  '-q:a',
  '2',
  '-y',
  output,
];

const twoInputCopyArgs = (videoUrl: string, audioUrl: string, output: string): string[] => [
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
  '-y',
  output,
];

// ─── DASH download ───

export const downloadDashMuxed = async (
  manifestUrl: string,
  fileName: string,
  output: 'mp4' | 'mp3',
  key: string,
  headers?: Record<string, string>,
): Promise<{ blobUrl: string; ext: string }> => {
  void fileName;
  await updateProgress(key, { stage: 'fetch-manifest', downloadedBytes: 0 });

  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const useAuthFallback = needsAuthFallback(headers);
  const ext = output === 'mp3' ? '.mp3' : '.mp4';
  const outputOpfsName = opfsNameFor(key, 'out', output);
  // Fetch the MPD once — we need it for duration in both paths and for
  // segment URLs in the auth-fallback path.
  const mpdText = await fetchMpdText(manifestUrl);
  if (/<ContentProtection\b/i.test(mpdText)) {
    throw new Error('This video is DRM-protected and cannot be downloaded.');
  }
  const durationSeconds = dashManifestDurationSeconds(mpdText);
  let videoInputOpfs: string | null = null;
  let audioInputOpfs: string | null = null;
  let videoBlobUrl: string | null = null;
  let audioBlobUrl: string | null = null;

  try {
    if (!useAuthFallback) {
      // Direct: libav demuxes DASH natively, pulling each representation over
      // jsfetch. DNR rewrites still apply to those sub-fetches.
      const jsfetchUrl = jsfetchInputForUrl(manifestUrl);
      const args =
        output === 'mp3'
          ? dashMp3TranscodeArgs(jsfetchUrl, outputOpfsName)
          : dashMp4MuxArgs(jsfetchUrl, outputOpfsName);
      await muxInWorker({ jobKey: key, outputOpfsName, ffmpegArgs: args, durationSeconds });
    } else {
      // Auth-fallback: parse the MPD, pre-fetch video + audio segments into
      // separate OPFS files, then feed libav two jsfetch:blob inputs.
      const tracks = parseDashSegments(mpdText, manifestUrl);
      if (!tracks.video && !tracks.audio) throw new Error('No tracks found in DASH manifest');

      let totalBytes = 0;

      if (tracks.video) {
        videoInputOpfs = opfsNameFor(key, 'in-video', 'mp4');
        const { totalBytes: vb } = await fetchSegmentsToOpfs({
          jobKey: key,
          opfsName: videoInputOpfs,
          segments: tracks.video.segmentUrls.map((url, i) => ({ url, sequenceNumber: i })),
          initUrl: tracks.video.initUrl,
          keyHeaders: headers,
          stage: 'download-video',
        });
        totalBytes += vb;
      }
      if (tracks.audio) {
        audioInputOpfs = opfsNameFor(key, 'in-audio', 'mp4');
        const { totalBytes: ab } = await fetchSegmentsToOpfs({
          jobKey: key,
          opfsName: audioInputOpfs,
          segments: tracks.audio.segmentUrls.map((url, i) => ({ url, sequenceNumber: i })),
          initUrl: tracks.audio.initUrl,
          keyHeaders: headers,
          stage: 'download-audio',
        });
        totalBytes += ab;
      }

      // Video-only fMP4 + MP4 output: init + fMP4 IS the MP4, skip libav.
      if (output !== 'mp3' && videoInputOpfs && !audioInputOpfs) {
        const file = await getOpfsFile(videoInputOpfs);
        const blobUrl = URL.createObjectURL(file);
        registerOutputForCleanup(blobUrl, videoInputOpfs);
        videoInputOpfs = null;
        await clearProgress(key);
        return { blobUrl, ext: '.mp4' };
      }

      await preflightDiskSpace(totalBytes);

      const videoJsfetch = videoInputOpfs ? await jsfetchInputForOpfs(videoInputOpfs) : null;
      if (videoJsfetch) videoBlobUrl = videoJsfetch.blobUrl;
      const audioJsfetch = audioInputOpfs ? await jsfetchInputForOpfs(audioInputOpfs) : null;
      if (audioJsfetch) audioBlobUrl = audioJsfetch.blobUrl;

      let args: string[];
      if (output === 'mp3') {
        // Prefer audio track; fall back to extracting audio from video track.
        const sourceUrl = audioJsfetch?.jsfetchUrl ?? videoJsfetch!.jsfetchUrl;
        args = mp3TranscodeArgs(sourceUrl, outputOpfsName);
      } else if (videoJsfetch && audioJsfetch) {
        args = twoInputCopyArgs(videoJsfetch.jsfetchUrl, audioJsfetch.jsfetchUrl, outputOpfsName);
      } else {
        // Audio-only MP4 output (rare but valid).
        args = mp4StreamCopyArgs(audioJsfetch!.jsfetchUrl, outputOpfsName);
      }
      await muxInWorker({
        jobKey: key,
        outputOpfsName,
        ffmpegArgs: args,
        durationSeconds,
        estimatedBytes: output === 'mp3' ? undefined : totalBytes,
      });

      if (videoBlobUrl) URL.revokeObjectURL(videoBlobUrl);
      if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl);
      videoBlobUrl = null;
      audioBlobUrl = null;
      if (videoInputOpfs) {
        void removeOpfs(videoInputOpfs).catch(() => undefined);
        videoInputOpfs = null;
      }
      if (audioInputOpfs) {
        void removeOpfs(audioInputOpfs).catch(() => undefined);
        audioInputOpfs = null;
      }
    }

    const outputFile = await getOpfsFile(outputOpfsName);
    const blobUrl = URL.createObjectURL(outputFile);
    registerOutputForCleanup(blobUrl, outputOpfsName);
    await clearProgress(key);
    return { blobUrl, ext };
  } catch (err) {
    if (videoBlobUrl) {
      try {
        URL.revokeObjectURL(videoBlobUrl);
      } catch {
        /* ignore */
      }
    }
    if (audioBlobUrl) {
      try {
        URL.revokeObjectURL(audioBlobUrl);
      } catch {
        /* ignore */
      }
    }
    if (videoInputOpfs) void removeOpfs(videoInputOpfs).catch(() => undefined);
    if (audioInputOpfs) void removeOpfs(audioInputOpfs).catch(() => undefined);
    void removeOpfs(outputOpfsName).catch(() => undefined);
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};
