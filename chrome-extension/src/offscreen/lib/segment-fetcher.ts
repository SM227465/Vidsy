import { decryptSegment } from './hls-crypto';
import { updateProgress } from './progress';
import type { HlsKeyInfo } from './m3u8-parser';

const MAX_CONCURRENT_SEGMENTS = 6;
const MAX_SEGMENT_RETRIES = 3;
const SEGMENT_TIMEOUT_MS = 30_000;

const activeAbortControllers = new Map<string, AbortController>();

const fetchSegmentWithRetry = async (
  url: string,
  signal?: AbortSignal,
  retries = MAX_SEGMENT_RETRIES,
): Promise<ArrayBuffer> => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(SEGMENT_TIMEOUT_MS);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(url, {
        signal: combinedSignal,
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal?.aborted) throw new DOMException('Download cancelled', 'AbortError');
      if (attempt === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error('Unreachable');
};

interface SegmentDownloadResult {
  chunks: ArrayBuffer[];
  totalBytes: number;
}

const downloadSegments = async (
  segments: { url: string; keyInfo?: HlsKeyInfo; sequenceNumber: number }[],
  key: string,
  stage: 'download-video' | 'download-audio',
  abortController: AbortController,
): Promise<SegmentDownloadResult> => {
  const segmentBuffers = new Array<ArrayBuffer | null>(segments.length).fill(null);
  let segmentsCompleted = 0;
  let totalDownloaded = 0;

  const semaphore = { count: MAX_CONCURRENT_SEGMENTS };
  const acquire = () =>
    new Promise<void>(resolve => {
      const check = () => {
        if (semaphore.count > 0) {
          semaphore.count--;
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  const release = () => {
    semaphore.count++;
  };

  const errors: Error[] = [];
  const fetchPromises = segments.map(async (seg, i) => {
    await acquire();
    try {
      let buffer = await fetchSegmentWithRetry(seg.url, abortController.signal, MAX_SEGMENT_RETRIES);
      if (seg.keyInfo?.method === 'AES-128') {
        buffer = await decryptSegment(buffer, seg.keyInfo, seg.sequenceNumber);
      }
      segmentBuffers[i] = buffer;

      // Update progress on EVERY segment completion (not just in-order)
      segmentsCompleted++;
      totalDownloaded += buffer.byteLength;
      const estimatedBytes = Math.round((totalDownloaded / segmentsCompleted) * segments.length);
      await updateProgress(key, { stage, downloadedBytes: totalDownloaded, estimatedBytes });
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    } finally {
      release();
    }
  });

  await Promise.all(fetchPromises);
  if (abortController.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
  if (errors.length > 0) throw new Error(`Failed ${errors.length} segments: ${errors[0].message}`);

  // Collect in order
  const chunks: ArrayBuffer[] = [];
  for (let i = 0; i < segments.length; i++) {
    chunks.push(segmentBuffers[i]!);
    segmentBuffers[i] = null; // free memory
  }

  return { chunks, totalBytes: totalDownloaded };
};

export {
  MAX_CONCURRENT_SEGMENTS,
  MAX_SEGMENT_RETRIES,
  SEGMENT_TIMEOUT_MS,
  activeAbortControllers,
  fetchSegmentWithRetry,
  downloadSegments,
};
