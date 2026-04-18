import { registerOutputForCleanup } from './blob-cleanup';
import { jsfetchInputForOpfs, preflightDiskSpace } from './libav-mux';
import { updateProgress, clearProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import {
  cancelWorkerJob,
  fetchRangesToOpfs,
  fetchUrlToOpfs,
  getOpfsFile,
  muxInWorker,
  removeOpfs,
} from './worker-client';

const MIN_SIZE_FOR_PARALLEL = 5 * 1024 * 1024; // 5 MB
const TARGET_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB per range request
const MAX_PARALLEL_CHUNKS = 6;
const PROBE_TIMEOUT_MS = 10_000;

type RangeProbe = {
  supportsRange: boolean;
  totalBytes?: number;
  contentType: string;
};

const extFromContentType = (contentType: string): string => {
  if (contentType.includes('webm')) return '.webm';
  if (contentType.includes('mp3') || contentType.includes('mpeg')) return '.mp3';
  if (contentType.includes('ogg')) return '.ogg';
  if (contentType.includes('m4a')) return '.m4a';
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('flac')) return '.flac';
  return '.mp4';
};

const probeRangeSupport = async (url: string, signal: AbortSignal): Promise<RangeProbe> => {
  const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
  const res = await fetch(url, {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
    signal: combinedSignal,
    credentials: 'include',
  });
  await res.arrayBuffer().catch(() => undefined);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    throw new Error('URL returned HTML, not a media file');
  }

  if (res.status === 206) {
    const contentRange = res.headers.get('content-range') ?? '';
    const match = contentRange.match(/\/(\d+)$/);
    const totalBytes = match ? parseInt(match[1], 10) : undefined;
    return { supportsRange: true, totalBytes, contentType };
  }
  const contentLengthHeader = res.headers.get('content-length');
  const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
  return { supportsRange: false, totalBytes, contentType };
};

const computeRanges = (totalBytes: number): { start: number; end: number }[] => {
  const chunkCount = Math.min(Math.ceil(totalBytes / TARGET_CHUNK_SIZE), MAX_PARALLEL_CHUNKS * 8);
  const chunkSize = Math.ceil(totalBytes / chunkCount);
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, totalBytes - 1);
    if (start > end) break;
    ranges.push({ start, end });
  }
  return ranges;
};

const opfsNameFor = (key: string, tag: string, ext: string): string =>
  `http-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}-${Date.now().toString(36)}.${ext}`;

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

// Download a URL into OPFS, returning the resulting File + resolved content-type.
// Picks Range-parallel when the server supports it and the payload is large enough,
// with the streaming fallback routed through the same worker.
export const downloadUrlToOpfs = async (args: {
  url: string;
  jobKey: string;
  opfsName: string;
  stage: 'download-video' | 'download-audio';
  signal: AbortSignal;
}): Promise<{ file: File; contentType: string; totalBytes: number }> => {
  const { url, jobKey, opfsName, stage, signal } = args;

  let probe: RangeProbe | null = null;
  try {
    probe = await probeRangeSupport(url, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    probe = null;
  }

  const canParallelize =
    !!probe && probe.supportsRange && probe.totalBytes !== undefined && probe.totalBytes >= MIN_SIZE_FOR_PARALLEL;

  if (canParallelize && probe?.totalBytes) {
    try {
      const ranges = computeRanges(probe.totalBytes);
      const { totalBytes } = await fetchRangesToOpfs({
        jobKey,
        opfsName,
        url,
        ranges,
        totalBytes: probe.totalBytes,
        stage,
      });
      const file = await getOpfsFile(opfsName);
      return { file, contentType: probe.contentType, totalBytes };
    } catch (err) {
      if (signal.aborted) throw err;
      // Range-parallel failed; fall back to streaming.
      try {
        await removeOpfs(opfsName);
      } catch {
        /* ignore */
      }
    }
  }

  const { totalBytes } = await fetchUrlToOpfs({ jobKey, opfsName, url, stage });
  const file = await getOpfsFile(opfsName);
  return { file, contentType: probe?.contentType ?? '', totalBytes };
};

/**
 * HTTP direct download. Streams bytes into OPFS via the download worker, then
 * hands the disk-backed File to chrome.downloads (MP4) or transcodes in-place
 * through libav+OPFS (MP3). Peak JS heap stays near zero regardless of size.
 */
export const downloadHttpDirect = async (
  url: string,
  key: string,
  output: 'mp4' | 'mp3' = 'mp4',
): Promise<{ blobUrl: string; ext: string }> => {
  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const inputOpfsName = opfsNameFor(key, 'in', 'bin');
  let outputOpfsName: string | null = null;
  let inputBlobUrl: string | null = null;

  try {
    await updateProgress(key, { stage: 'download-video', downloadedBytes: 0 });

    const {
      file: inputFile,
      contentType,
      totalBytes,
    } = await downloadUrlToOpfs({
      url,
      jobKey: key,
      opfsName: inputOpfsName,
      stage: 'download-video',
      signal: abortController.signal,
    });

    if (output === 'mp3') {
      await preflightDiskSpace(totalBytes);
      outputOpfsName = opfsNameFor(key, 'out', 'mp3');
      const { jsfetchUrl, blobUrl } = await jsfetchInputForOpfs(inputOpfsName);
      inputBlobUrl = blobUrl;
      await muxInWorker({
        jobKey: key,
        outputOpfsName,
        ffmpegArgs: mp3TranscodeArgs(jsfetchUrl, outputOpfsName),
        estimatedBytes: totalBytes,
      });
      URL.revokeObjectURL(inputBlobUrl);
      inputBlobUrl = null;
      void removeOpfs(inputOpfsName).catch(() => undefined);

      const outputFile = await getOpfsFile(outputOpfsName);
      const outputBlobUrl = URL.createObjectURL(outputFile);
      registerOutputForCleanup(outputBlobUrl, outputOpfsName);
      await clearProgress(key);
      return { blobUrl: outputBlobUrl, ext: '.mp3' };
    }

    const blobUrl = URL.createObjectURL(inputFile);
    outputOpfsName = inputOpfsName;
    registerOutputForCleanup(blobUrl, outputOpfsName);
    await clearProgress(key);
    return { blobUrl, ext: extFromContentType(contentType) };
  } catch (err) {
    if (inputBlobUrl) {
      try {
        URL.revokeObjectURL(inputBlobUrl);
      } catch {
        /* ignore */
      }
    }
    void removeOpfs(inputOpfsName).catch(() => undefined);
    if (outputOpfsName && outputOpfsName !== inputOpfsName) {
      void removeOpfs(outputOpfsName).catch(() => undefined);
    }
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};
