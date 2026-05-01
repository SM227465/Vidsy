import { registerOutputForCleanup } from './blob-cleanup';
import { downloadUrlToOpfs } from './http-download';
import { jsfetchInputForOpfs, preflightDiskSpace } from './libav-mux';
import { updateProgress, clearProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import { cancelWorkerJob, getOpfsFile, muxInWorker, removeOpfs } from './worker-client';

const extFromMime = (mime: string | undefined, fallback: string): string => {
  if (!mime) return fallback;
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('aac')) return '.aac';
  if (mime.includes('mpeg')) return '.mp3';
  return fallback;
};

const opfsNameFor = (key: string, tag: string, ext: string): string =>
  `merged-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}-${Date.now().toString(36)}${ext}`;

// Let libav pick whichever input carries video vs. audio rather than
// assuming input 0 = video, input 1 = audio. Some sites (Instagram) serve
// adaptive media as two MP4 URLs with arbitrary track ordering, so the
// order in which we detected them is not reliable.
const twoInputCopyArgs = (videoUrl: string, audioUrl: string, output: string): string[] => [
  '-i',
  videoUrl,
  '-i',
  audioUrl,
  '-map',
  '0:v?',
  '-map',
  '1:v?',
  '-map',
  '0:a?',
  '-map',
  '1:a?',
  '-c',
  'copy',
  '-y',
  output,
];

// Sequentially download video + audio into OPFS, then feed libav two
// jsfetch:blob inputs for a zero-copy stream-copy mux. Both sources stay
// disk-backed; libav's only in-RAM state is its internal ring buffer.
export const downloadMerged = async (
  videoUrl: string,
  audioUrl: string,
  videoMimeType: string | undefined,
  audioMimeType: string | undefined,
  key: string,
): Promise<{ blobUrl: string; ext: string }> => {
  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const videoExt = extFromMime(videoMimeType, '.mp4');
  const audioExt = extFromMime(audioMimeType, '.m4a');
  const videoOpfsName = opfsNameFor(key, 'video', videoExt);
  const audioOpfsName = opfsNameFor(key, 'audio', audioExt);
  const outputOpfsName = opfsNameFor(key, 'out', '.mp4');
  let videoBlobUrl: string | null = null;
  let audioBlobUrl: string | null = null;

  try {
    await updateProgress(key, { stage: 'download-video', downloadedBytes: 0 });
    const videoDownload = await downloadUrlToOpfs({
      url: videoUrl,
      jobKey: key,
      opfsName: videoOpfsName,
      stage: 'download-video',
      signal: abortController.signal,
    });

    if (abortController.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');

    await updateProgress(key, { stage: 'download-audio', downloadedBytes: 0 });
    const audioDownload = await downloadUrlToOpfs({
      url: audioUrl,
      jobKey: key,
      opfsName: audioOpfsName,
      stage: 'download-audio',
      signal: abortController.signal,
    });

    if (abortController.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');

    const totalInputBytes = videoDownload.totalBytes + audioDownload.totalBytes;
    await preflightDiskSpace(totalInputBytes);

    const videoJs = await jsfetchInputForOpfs(videoOpfsName);
    videoBlobUrl = videoJs.blobUrl;
    const audioJs = await jsfetchInputForOpfs(audioOpfsName);
    audioBlobUrl = audioJs.blobUrl;

    await muxInWorker({
      jobKey: key,
      outputOpfsName,
      ffmpegArgs: twoInputCopyArgs(videoJs.jsfetchUrl, audioJs.jsfetchUrl, outputOpfsName),
      estimatedBytes: totalInputBytes,
    });

    URL.revokeObjectURL(videoBlobUrl);
    URL.revokeObjectURL(audioBlobUrl);
    videoBlobUrl = null;
    audioBlobUrl = null;
    void removeOpfs(videoOpfsName).catch(() => undefined);
    void removeOpfs(audioOpfsName).catch(() => undefined);

    const outputFile = await getOpfsFile(outputOpfsName);
    const blobUrl = URL.createObjectURL(outputFile);
    registerOutputForCleanup(blobUrl, outputOpfsName);
    await clearProgress(key);
    return { blobUrl, ext: '.mp4' };
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
    void removeOpfs(videoOpfsName).catch(() => undefined);
    void removeOpfs(audioOpfsName).catch(() => undefined);
    void removeOpfs(outputOpfsName).catch(() => undefined);
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};
