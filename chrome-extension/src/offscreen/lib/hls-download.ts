import { registerOutputForCleanup } from './blob-cleanup';
import {
  hlsManifestDurationSeconds,
  jsfetchInputForOpfs,
  jsfetchInputForUrl,
  needsAuthFallback,
  preflightDiskSpace,
} from './libav-mux';
import { parseHlsPlaylist } from './m3u8-parser';
import { updateProgress, clearProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import { cancelWorkerJob, fetchSegmentsToOpfs, getOpfsFile, muxInWorker, removeOpfs } from './worker-client';

const opfsNameFor = (key: string, tag: string, ext: string): string =>
  `hls-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}-${Date.now().toString(36)}.${ext}`;

type ResolvedPlaylist = { url: string; manifestText: string };

const resolveVariantPlaylist = async (playlistUrl: string): Promise<ResolvedPlaylist> => {
  const res = await fetch(playlistUrl, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch HLS playlist: ${res.status}`);
  const manifestText = await res.text();
  // SAMPLE-AES / FairPlay / PlayReady / Widevine = DRM. Plain AES-128 is fine — libav handles it.
  if (
    /METHOD=SAMPLE-AES|URI="skd:\/\/|KEYFORMAT="(?:com\.apple\.streamingkeydelivery|com\.microsoft\.playready|com\.widevine\.alpha|urn:uuid:)/i.test(
      manifestText,
    )
  ) {
    throw new Error('This video is DRM-protected and cannot be downloaded.');
  }
  if (!manifestText.includes('#EXT-X-STREAM-INF')) return { url: playlistUrl, manifestText };

  const lines = manifestText.split('\n').map(l => l.trim());
  let bestBandwidth = -1;
  let bestUrl = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const bwMatch = line.match(/BANDWIDTH=(\d+)/);
    const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
    let j = i + 1;
    while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) j++;
    if (j < lines.length && bw > bestBandwidth) {
      bestBandwidth = bw;
      bestUrl = new URL(lines[j], playlistUrl).toString();
    }
  }
  if (!bestUrl) throw new Error('No variant stream found in master playlist');
  return resolveVariantPlaylist(bestUrl);
};

const mp4StreamCopyArgs = (input: string, output: string): string[] => ['-i', input, '-c', 'copy', '-y', output];

const hlsMp4StreamCopyArgs = (jsfetchUrl: string, output: string): string[] => [
  '-f',
  'hls',
  '-i',
  jsfetchUrl,
  '-c',
  'copy',
  '-y',
  output,
];

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

const hlsMp3TranscodeArgs = (jsfetchUrl: string, output: string): string[] => [
  '-f',
  'hls',
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

export const downloadHlsMuxed = async (
  playlistUrl: string,
  fileName: string,
  output: 'mp4' | 'mp3',
  key: string,
  headers?: Record<string, string>,
): Promise<{ blobUrl: string; ext: string }> => {
  void fileName;
  await updateProgress(key, { stage: 'fetch-manifest', downloadedBytes: 0 });

  const { url: variantUrl, manifestText } = await resolveVariantPlaylist(playlistUrl);

  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const useAuthFallback = needsAuthFallback(headers);
  const ext = output === 'mp3' ? '.mp3' : '.mp4';
  const outputOpfsName = opfsNameFor(key, 'out', output);
  const durationSeconds = hlsManifestDurationSeconds(manifestText);
  let inputOpfsName: string | null = null;
  let inputBlobUrl: string | null = null;

  try {
    if (!useAuthFallback) {
      // Direct: libav demuxes HLS natively and writes the MP4/MP3 to OPFS.
      const jsfetchUrl = jsfetchInputForUrl(variantUrl);
      const args =
        output === 'mp3'
          ? hlsMp3TranscodeArgs(jsfetchUrl, outputOpfsName)
          : hlsMp4StreamCopyArgs(jsfetchUrl, outputOpfsName);
      await muxInWorker({ jobKey: key, outputOpfsName, ffmpegArgs: args, durationSeconds });
    } else {
      // Auth-fallback: pre-fetch segments into OPFS so DNR-rewritten auth
      // headers reach the CDN, then feed libav an OPFS-backed blob URL.
      const { segments, mapUrl } = parseHlsPlaylist(manifestText, variantUrl);
      if (segments.length === 0) throw new Error('No segments in HLS playlist');
      const isFmp4 = Boolean(mapUrl);
      inputOpfsName = opfsNameFor(key, 'in', isFmp4 ? 'mp4' : 'ts');

      const { totalBytes } = await fetchSegmentsToOpfs({
        jobKey: key,
        opfsName: inputOpfsName,
        segments: segments.map(s => ({ url: s.url, keyInfo: s.keyInfo, sequenceNumber: s.sequenceNumber })),
        initUrl: mapUrl,
        keyHeaders: headers,
        stage: 'download-video',
      });

      if (output !== 'mp3' && isFmp4) {
        // init + fMP4 segments concatenated IS a valid MP4 — skip libav entirely.
        const file = await getOpfsFile(inputOpfsName);
        const blobUrl = URL.createObjectURL(file);
        registerOutputForCleanup(blobUrl, inputOpfsName);
        inputOpfsName = null; // hand-off: do not remove on cleanup
        await clearProgress(key);
        return { blobUrl, ext: '.mp4' };
      }

      // Need room for the output (≈ totalBytes for stream-copy MP4,
      // noticeably less for MP3 but still nonzero). Fail cleanly up front.
      await preflightDiskSpace(totalBytes);

      const { jsfetchUrl, blobUrl } = await jsfetchInputForOpfs(inputOpfsName);
      inputBlobUrl = blobUrl;

      const args =
        output === 'mp3' ? mp3TranscodeArgs(jsfetchUrl, outputOpfsName) : mp4StreamCopyArgs(jsfetchUrl, outputOpfsName);
      await muxInWorker({
        jobKey: key,
        outputOpfsName,
        ffmpegArgs: args,
        durationSeconds,
        estimatedBytes: output === 'mp3' ? undefined : totalBytes,
      });

      URL.revokeObjectURL(inputBlobUrl);
      inputBlobUrl = null;
      void removeOpfs(inputOpfsName).catch(() => undefined);
      inputOpfsName = null;
    }

    const outputFile = await getOpfsFile(outputOpfsName);
    const blobUrl = URL.createObjectURL(outputFile);
    registerOutputForCleanup(blobUrl, outputOpfsName);
    await clearProgress(key);
    return { blobUrl, ext };
  } catch (err) {
    if (inputBlobUrl) {
      try {
        URL.revokeObjectURL(inputBlobUrl);
      } catch {
        /* ignore */
      }
    }
    if (inputOpfsName) void removeOpfs(inputOpfsName).catch(() => undefined);
    void removeOpfs(outputOpfsName).catch(() => undefined);
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};
