// Download worker — spawned from the offscreen document.
// Owns OPFS I/O so segment / range streams land on disk via FileSystemSyncAccessHandle
// without holding payloads in the JS heap. The main thread still drives ffmpeg.wasm
// and mounts OPFS Files via WORKERFS at mux time.

import { createLibAV, registerJsfetch, registerOutputDevice } from './libav';
import { opfs } from './opfs';
import { decryptSegment } from '../lib/hls-crypto';
import type {
  FetchRangesRequest,
  FetchSegmentsRequest,
  FetchUrlRequest,
  MuxRequest,
  SegmentSpec,
  WorkerRequest,
  WorkerResponse,
} from './messages';
import type { ChunkProgress } from '@extension/shared';

const MAX_CONCURRENT = 8;
const MAX_RETRIES = 3;
const SEGMENT_TIMEOUT_MS = 30_000;

const post = (msg: WorkerResponse): void => {
  (self as unknown as Worker).postMessage(msg);
};

const activeAborts = new Map<string, AbortController>();

const fetchWithRetry = async (
  url: string,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
  retries = MAX_RETRIES,
): Promise<ArrayBuffer> => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(SEGMENT_TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeoutSignal]);
      const res = await fetch(url, { signal: combined, credentials: 'include', headers: extraHeaders });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      if (attempt === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error('Unreachable');
};

// Fetch `count` items in parallel (bounded by MAX_CONCURRENT), append their
// buffers to OPFS in strict index order, and report progress along the way.
// Used by both segment and range download paths.
//
// When `chunkMeta` is supplied (HTTP-range case), per-chunk progress is
// included on each `progress` message so the standalone download window can
// render a multi-band position bar plus a connections table.
const parallelFetchToOpfs = async (args: {
  opfsName: string;
  count: number;
  fetchOne: (i: number, signal: AbortSignal) => Promise<ArrayBuffer>;
  stage: 'download-video' | 'download-audio';
  jobKey: string;
  signal: AbortSignal;
  totalEstimatedBytes?: number;
  chunkMeta?: Array<{ start: number; end: number }>;
}): Promise<void> => {
  const { opfsName, count, fetchOne, stage, jobKey, signal, totalEstimatedBytes, chunkMeta } = args;

  const pending = new Map<number, Uint8Array>();
  let nextToWrite = 0;
  let completedCount = 0;
  let inFlight = 0;
  let cursor = 0;
  let finishedDispatching = false;
  const errors: Error[] = [];

  const chunkStates: ChunkProgress[] | undefined = chunkMeta?.map((m, i) => ({
    i,
    start: m.start,
    end: m.end,
    status: 'pending' as const,
  }));

  const flushInOrder = (): void => {
    while (pending.has(nextToWrite)) {
      const buf = pending.get(nextToWrite)!;
      pending.delete(nextToWrite);
      opfs.append(opfsName, buf);
      nextToWrite++;
    }
  };

  const dispatchOne = async (index: number): Promise<void> => {
    if (chunkStates && chunkStates[index]) chunkStates[index].status = 'fetching';
    try {
      const data = await fetchOne(index, signal);
      pending.set(index, new Uint8Array(data));
      completedCount++;
      if (chunkStates && chunkStates[index]) chunkStates[index].status = 'done';
      flushInOrder();
      // For Range downloads (chunkStates present) we report the sum of bytes
      // across all chunks that have completed fetching, not opfs.size(). The
      // two diverge when a low-indexed chunk is slow — its peers complete
      // and sit in memory waiting for the in-order flush, so opfs.size lags
      // by hundreds of MB. The chunk sum reflects real throughput and keeps
      // speed / ETA / status honest. Other paths still use the write cursor.
      const fetchedBytes = chunkStates
        ? chunkStates.reduce((sum, c) => (c.status === 'done' ? sum + (c.end - c.start + 1) : sum), 0)
        : opfs.size(opfsName);
      const estimatedBytes =
        totalEstimatedBytes ?? (completedCount > 0 ? Math.round((fetchedBytes / completedCount) * count) : undefined);
      post({
        type: 'progress',
        jobKey,
        stage,
        downloadedBytes: fetchedBytes,
        estimatedBytes,
        chunks: chunkStates ? chunkStates.map(c => ({ ...c })) : undefined,
      });
    } catch (err) {
      if (chunkStates && chunkStates[index]) chunkStates[index].status = 'error';
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // Periodic snapshot tick — keeps the UI's stats panel live even when no
  // chunk has completed in the last few hundred ms (slow links, big chunks).
  // The dispatchOne post fires on chunk completion; this fires on a 500ms
  // wall-clock cadence with the latest accumulated byte count + chunk states.
  const postSnapshot = (): void => {
    const fetchedBytes = chunkStates
      ? chunkStates.reduce((sum, c) => (c.status === 'done' ? sum + (c.end - c.start + 1) : sum), 0)
      : opfs.size(opfsName);
    const estBytes =
      totalEstimatedBytes ?? (completedCount > 0 ? Math.round((fetchedBytes / completedCount) * count) : undefined);
    post({
      type: 'progress',
      jobKey,
      stage,
      downloadedBytes: fetchedBytes,
      estimatedBytes: estBytes,
      chunks: chunkStates ? chunkStates.map(c => ({ ...c })) : undefined,
    });
  };
  const snapshotHandle: ReturnType<typeof setInterval> = setInterval(postSnapshot, 500);

  try {
    await new Promise<void>(resolve => {
      const tick = (): void => {
        if (signal.aborted || errors.length > 0) {
          if (inFlight === 0) resolve();
          return;
        }
        while (inFlight < MAX_CONCURRENT && cursor < count) {
          const i = cursor++;
          inFlight++;
          dispatchOne(i).finally(() => {
            inFlight--;
            if (finishedDispatching && inFlight === 0) resolve();
            else tick();
          });
        }
        if (cursor >= count) {
          finishedDispatching = true;
          if (inFlight === 0) resolve();
        }
      };
      tick();
    });
  } finally {
    clearInterval(snapshotHandle);
  }

  if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
  if (errors.length > 0) throw new Error(`Failed ${errors.length} parts: ${errors[0].message}`);
  flushInOrder();
  // One final snapshot so the UI sees the post-flush state immediately.
  postSnapshot();
};

const handleFetchSegments = async (req: FetchSegmentsRequest): Promise<void> => {
  const controller = new AbortController();
  activeAborts.set(req.jobKey, controller);
  const { jobId, jobKey, opfsName, segments, initUrl, keyHeaders, stage } = req;

  try {
    await opfs.open(opfsName);

    if (initUrl) {
      const init = await fetchWithRetry(initUrl, controller.signal);
      opfs.append(opfsName, init);
    }

    const fetchOne = async (i: number, signal: AbortSignal): Promise<ArrayBuffer> => {
      const spec: SegmentSpec = segments[i];
      let data = await fetchWithRetry(spec.url, signal);
      if (spec.keyInfo?.method === 'AES-128') {
        data = await decryptSegment(data, spec.keyInfo, spec.sequenceNumber, keyHeaders);
      }
      return data;
    };

    await parallelFetchToOpfs({
      opfsName,
      count: segments.length,
      fetchOne,
      stage,
      jobKey,
      signal: controller.signal,
    });

    await opfs.close(opfsName);
    const totalBytes = opfs.size(opfsName);
    post({ type: 'fetch-done', jobId, opfsName, totalBytes });
  } catch (err) {
    try {
      await opfs.remove(opfsName);
    } catch {
      /* ignore */
    }
    post({ type: 'error', jobId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    activeAborts.delete(jobKey);
  }
};

const handleFetchRanges = async (req: FetchRangesRequest): Promise<void> => {
  const controller = new AbortController();
  activeAborts.set(req.jobKey, controller);
  const { jobId, jobKey, opfsName, url, ranges, stage, totalBytes: knownTotal } = req;

  try {
    await opfs.open(opfsName);

    const fetchOne = (i: number, signal: AbortSignal): Promise<ArrayBuffer> => {
      const { start, end } = ranges[i];
      return fetchWithRetry(url, signal, { Range: `bytes=${start}-${end}` });
    };

    await parallelFetchToOpfs({
      opfsName,
      count: ranges.length,
      fetchOne,
      stage,
      jobKey,
      signal: controller.signal,
      totalEstimatedBytes: knownTotal,
      chunkMeta: ranges,
    });

    await opfs.close(opfsName);
    post({ type: 'fetch-done', jobId, opfsName, totalBytes: opfs.size(opfsName) });
  } catch (err) {
    try {
      await opfs.remove(opfsName);
    } catch {
      /* ignore */
    }
    post({ type: 'error', jobId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    activeAborts.delete(jobKey);
  }
};

const PROGRESS_POLL_MS = 250;

const handleMux = async (req: MuxRequest): Promise<void> => {
  const { jobId, jobKey, outputOpfsName, ffmpegArgs, stage, durationSeconds, estimatedBytes } = req;
  const controller = new AbortController();
  activeAborts.set(jobKey, controller);

  let libav: Awaited<ReturnType<typeof createLibAV>> | null = null;
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  const onAbort = (): void => {
    // libav.terminate() rejects the in-flight ffmpeg() promise on the next tick.
    try {
      libav?.terminate();
    } catch {
      /* ignore */
    }
  };
  controller.signal.addEventListener('abort', onAbort);

  try {
    console.log(`[mux] starting jobKey=${jobKey} args=${JSON.stringify(ffmpegArgs)}`);
    libav = await createLibAV();
    console.log(`[mux] libav instance created`);
    await registerOutputDevice(libav, outputOpfsName);
    await registerJsfetch(libav, {});
    console.log(`[mux] registration complete; invoking ffmpeg()`);

    // Emit one mux-stage event immediately so the UI flips off the stale
    // download-audio 100% and into the indeterminate "Processing…" state. The
    // per-tick poll below only fires when ffmpeg_get_out_time_ms is available
    // in the build; without it this is the only progress event the UI gets
    // during mux.
    post({
      type: 'progress',
      jobKey,
      stage,
      downloadedBytes: 0,
      estimatedBytes,
      muxPercent: undefined,
    });

    // MP3 transcode has output_size << input_size, so any size-ratio estimate
    // is misleading there — keep the indeterminate "Processing…" for MP3.
    // Stream-copy mux (.mp4 etc.) produces output ≈ input, so OPFS file size
    // is a reliable proxy.
    const isMp3Transcode = outputOpfsName.endsWith('.mp3');

    pollHandle = setInterval(() => {
      (async () => {
        try {
          if (!libav) return;
          // libav.ffmpeg_get_out_time_ms / get_total_size_bytes are an
          // extension some libav.js builds carry; the vendored h264-aac-mp3
          // build doesn't expose them. We try those first, then fall back to
          // the OPFS output file size (which the custom output device writes
          // to as the mux runs) for stream-copy.
          const getOutTime = libav.ffmpeg_get_out_time_ms as (() => Promise<number>) | undefined;
          const getTotalBytes = libav.ffmpeg_get_total_size_bytes as (() => Promise<number>) | undefined;
          const hasLibavProgress = typeof getOutTime === 'function' && typeof getTotalBytes === 'function';

          let outTimeMs = 0;
          let totalBytes = 0;
          if (hasLibavProgress) {
            outTimeMs = await getOutTime!.call(libav);
            totalBytes = await getTotalBytes!.call(libav);
          } else {
            totalBytes = opfs.size(outputOpfsName);
          }

          let muxPercent: number | undefined;
          if (durationSeconds && durationSeconds > 0 && outTimeMs > 0) {
            muxPercent = Math.min(99, Math.round((outTimeMs / 1000 / durationSeconds) * 100));
          } else if (!isMp3Transcode && estimatedBytes && estimatedBytes > 0 && totalBytes > 0) {
            muxPercent = Math.min(99, Math.round((totalBytes / estimatedBytes) * 100));
          }

          // Skip the post if we have nothing useful to report (avoid spamming
          // the storage with 0/undefined updates that overwrite a prior value).
          if (muxPercent === undefined && totalBytes === 0) return;

          post({
            type: 'progress',
            jobKey,
            stage,
            downloadedBytes: totalBytes,
            estimatedBytes,
            muxPercent,
          });
        } catch (pollErr) {
          console.warn('[mux] poll error (non-fatal):', pollErr);
        }
      })();
    }, PROGRESS_POLL_MS);

    const rc = await libav.ffmpeg(...ffmpegArgs);
    console.log(`[mux] ffmpeg() returned rc=${rc}`);

    // ffmpeg() returned — tear down poll, close OPFS, report size.
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;

    await opfs.close(outputOpfsName);
    const totalBytes = opfs.size(outputOpfsName);
    console.log(`[mux] done jobKey=${jobKey} totalBytes=${totalBytes}`);
    post({ type: 'mux-done', jobId, outputOpfsName, totalBytes });
  } catch (err) {
    console.error(`[mux] failed jobKey=${jobKey}:`, err);
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
    try {
      await opfs.remove(outputOpfsName);
    } catch {
      /* ignore */
    }
    post({ type: 'error', jobId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    controller.signal.removeEventListener('abort', onAbort);
    if (pollHandle) clearInterval(pollHandle);
    try {
      libav?.terminate();
    } catch {
      /* already torn down */
    }
    activeAborts.delete(jobKey);
  }
};

const handleFetchUrl = async (req: FetchUrlRequest): Promise<void> => {
  const controller = new AbortController();
  activeAborts.set(req.jobKey, controller);
  const { jobId, jobKey, opfsName, url, stage } = req;

  try {
    await opfs.open(opfsName);
    const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    let downloaded = 0;
    const totalHeader = res.headers.get('content-length');
    const estimatedBytes = totalHeader ? parseInt(totalHeader, 10) : undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (controller.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      opfs.append(opfsName, value);
      downloaded += value.byteLength;
      post({ type: 'progress', jobKey, stage, downloadedBytes: downloaded, estimatedBytes });
    }

    await opfs.close(opfsName);
    post({ type: 'fetch-done', jobId, opfsName, totalBytes: opfs.size(opfsName) });
  } catch (err) {
    try {
      await opfs.remove(opfsName);
    } catch {
      /* ignore */
    }
    post({ type: 'error', jobId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    activeAborts.delete(jobKey);
  }
};

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  switch (req.type) {
    case 'ping':
      post({ type: 'pong' });
      return;

    case 'remove':
      try {
        await opfs.remove(req.opfsName);
        post({ type: 'remove-done', jobId: req.jobId });
      } catch (err) {
        post({ type: 'error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
      }
      return;

    case 'get-file':
      try {
        const file = await opfs.getFile(req.opfsName);
        post({ type: 'get-file-done', jobId: req.jobId, file });
      } catch (err) {
        post({ type: 'error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
      }
      return;

    case 'write-bytes':
      try {
        await opfs.open(req.opfsName);
        opfs.append(req.opfsName, new Uint8Array(req.bytes));
        const file = await opfs.getFile(req.opfsName);
        post({ type: 'get-file-done', jobId: req.jobId, file });
      } catch (err) {
        try {
          await opfs.remove(req.opfsName);
        } catch {
          /* ignore */
        }
        post({ type: 'error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
      }
      return;

    case 'cancel': {
      const ctl = activeAborts.get(req.jobKey);
      if (ctl) ctl.abort();
      return;
    }

    case 'fetch-segments':
      void handleFetchSegments(req);
      return;

    case 'fetch-ranges':
      void handleFetchRanges(req);
      return;

    case 'fetch-url':
      void handleFetchUrl(req);
      return;

    case 'mux':
      void handleMux(req);
      return;

    default: {
      const _exhaustive: never = req;
      void _exhaustive;
    }
  }
});
