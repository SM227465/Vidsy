// Typed RPC client around the download worker (dist/download_worker/main.js).
// The worker owns OPFS. This module is the only place that speaks the worker protocol.

import { updateProgress } from './progress';
import type {
  FetchRangesRequest,
  FetchSegmentsRequest,
  FetchUrlRequest,
  MuxRequest,
  ProgressUpdate,
  SegmentSpec,
  WorkerRequest,
  WorkerResponse,
} from '../download_worker/messages';
import type { ChunkProgress } from '@extension/shared';

// Storage is dynamically imported so its module-level createStorage calls
// (which can throw in some offscreen contexts when chrome.storage is being
// looked up by bracket access against a session storage area) can't break
// the entire offscreen module's load. The actual resume / connection-count
// reads run on first download, well after module init.

let worker: Worker | null = null;
let jobCounter = 0;

const getWorker = (): Worker => {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('download_worker/main.js'), { type: 'module' });
  }
  return worker;
};

const nextJobId = (): string => `j${++jobCounter}_${Date.now().toString(36)}`;

type PendingJob = {
  resolve: (totalBytes: number) => void;
  reject: (err: Error) => void;
};
type PendingFile = {
  resolve: (file: File) => void;
  reject: (err: Error) => void;
};
type PendingAck = {
  resolve: () => void;
  reject: (err: Error) => void;
};
type PendingMux = {
  resolve: (result: { outputOpfsName: string; totalBytes: number }) => void;
  reject: (err: Error) => void;
};

const pendingFetch = new Map<string, PendingJob>();
const pendingFile = new Map<string, PendingFile>();
const pendingAck = new Map<string, PendingAck>();
const pendingMux = new Map<string, PendingMux>();

const ensureListener = (() => {
  let attached = false;
  return (): void => {
    if (attached) return;
    attached = true;
    getWorker().addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'progress': {
          const { jobKey, stage, downloadedBytes, estimatedBytes, muxPercent, chunks } = msg as ProgressUpdate;
          void updateProgress(jobKey, { stage, downloadedBytes, estimatedBytes, muxPercent, chunks });
          return;
        }
        case 'fetch-done': {
          const p = pendingFetch.get(msg.jobId);
          if (p) {
            pendingFetch.delete(msg.jobId);
            p.resolve(msg.totalBytes);
          }
          return;
        }
        case 'mux-done': {
          const p = pendingMux.get(msg.jobId);
          if (p) {
            pendingMux.delete(msg.jobId);
            p.resolve({ outputOpfsName: msg.outputOpfsName, totalBytes: msg.totalBytes });
          }
          return;
        }
        case 'get-file-done': {
          const p = pendingFile.get(msg.jobId);
          if (p) {
            pendingFile.delete(msg.jobId);
            p.resolve(msg.file);
          }
          return;
        }
        case 'remove-done': {
          const p = pendingAck.get(msg.jobId);
          if (p) {
            pendingAck.delete(msg.jobId);
            p.resolve();
          }
          return;
        }
        case 'error': {
          const err = new Error(msg.error);
          const f = pendingFetch.get(msg.jobId);
          if (f) {
            pendingFetch.delete(msg.jobId);
            f.reject(err);
            return;
          }
          const g = pendingFile.get(msg.jobId);
          if (g) {
            pendingFile.delete(msg.jobId);
            g.reject(err);
            return;
          }
          const a = pendingAck.get(msg.jobId);
          if (a) {
            pendingAck.delete(msg.jobId);
            a.reject(err);
            return;
          }
          const m = pendingMux.get(msg.jobId);
          if (m) {
            pendingMux.delete(msg.jobId);
            m.reject(err);
          }
          return;
        }
        case 'pong':
          return;
      }
    });
  };
})();

const send = (req: WorkerRequest): void => {
  ensureListener();
  getWorker().postMessage(req);
};

const fetchSegmentsToOpfs = (args: {
  jobKey: string;
  opfsName: string;
  segments: SegmentSpec[];
  initUrl?: string;
  keyHeaders?: Record<string, string>;
  stage: 'download-video' | 'download-audio';
}): Promise<{ opfsName: string; totalBytes: number }> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFetch.set(jobId, {
      resolve: totalBytes => resolve({ opfsName: args.opfsName, totalBytes }),
      reject,
    });
    const req: FetchSegmentsRequest = { type: 'fetch-segments', jobId, ...args };
    send(req);
  });

// Look up any prior chunk state for this jobKey so the worker can skip
// chunks that already completed in a paused / interrupted previous run.
// We only resume if the ranges match (same file, same chunking strategy);
// otherwise the OPFS bytes would belong to a different layout.
//
// Two sources are consulted, in order:
//   1. mediaDownloadsStorage (session) — populated continuously during a
//      same-session pause/resume. Wins when present.
//   2. mediaResumablesStorage (local) — populated on pause as a persistent
//      snapshot, used to resume after a browser restart. Falls back here when
//      session storage has no entry (typical post-restart case).
const validateChunksForRanges = (
  chunks: ChunkProgress[] | undefined,
  estimatedBytes: number | undefined,
  ranges: { start: number; end: number }[],
  totalBytes: number,
): ChunkProgress[] | undefined => {
  if (!chunks?.length) return undefined;
  if (estimatedBytes !== totalBytes) return undefined;
  if (chunks.length !== ranges.length) return undefined;
  // Reject if ANY range boundary disagrees with the prior state — chunking
  // is deterministic for a given totalBytes but defense in depth.
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const p = chunks[i];
    if (!p || p.i !== i || p.start !== r.start || p.end !== r.end) return undefined;
  }
  const done = chunks.filter(c => c.status === 'done');
  return done.length > 0 ? done : undefined;
};

const findResumeChunks = async (
  jobKey: string,
  ranges: { start: number; end: number }[],
  totalBytes: number,
): Promise<ChunkProgress[] | undefined> => {
  try {
    const { mediaDownloadsStorage, mediaResumablesStorage } = await import('@extension/storage');
    const session = (await mediaDownloadsStorage.get())[jobKey];
    const fromSession = validateChunksForRanges(session?.chunks, session?.estimatedBytes, ranges, totalBytes);
    if (fromSession) return fromSession;
    const manifest = (await mediaResumablesStorage.get())[jobKey];
    if (!manifest) return undefined;
    return validateChunksForRanges(manifest.chunks, manifest.totalBytes, ranges, totalBytes);
  } catch {
    return undefined;
  }
};

const readMaxConnections = async (): Promise<number> => {
  try {
    const { mediaSettingsStorage } = await import('@extension/storage');
    const s = await mediaSettingsStorage.get();
    return Math.max(1, Math.min(16, Math.floor(s.downloadConnectionsPerFile ?? 8)));
  } catch {
    return 8;
  }
};

const fetchRangesToOpfs = (args: {
  jobKey: string;
  opfsName: string;
  url: string;
  ranges: { start: number; end: number }[];
  totalBytes: number;
  stage: 'download-video' | 'download-audio';
}): Promise<{ opfsName: string; totalBytes: number }> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFetch.set(jobId, {
      resolve: totalBytes => resolve({ opfsName: args.opfsName, totalBytes }),
      reject,
    });
    void Promise.all([findResumeChunks(args.jobKey, args.ranges, args.totalBytes), readMaxConnections()]).then(
      ([resumeChunks, maxConnections]) => {
        const req: FetchRangesRequest = { type: 'fetch-ranges', jobId, ...args, resumeChunks, maxConnections };
        send(req);
      },
    );
  });

const fetchUrlToOpfs = (args: {
  jobKey: string;
  opfsName: string;
  url: string;
  stage: 'download-video' | 'download-audio';
}): Promise<{ opfsName: string; totalBytes: number }> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFetch.set(jobId, {
      resolve: totalBytes => resolve({ opfsName: args.opfsName, totalBytes }),
      reject,
    });
    const req: FetchUrlRequest = { type: 'fetch-url', jobId, ...args };
    send(req);
  });

const getOpfsFile = (opfsName: string): Promise<File> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFile.set(jobId, { resolve, reject });
    send({ type: 'get-file', jobId, opfsName });
  });

const writeBytesToOpfs = (opfsName: string, bytes: ArrayBuffer): Promise<File> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFile.set(jobId, { resolve, reject });
    ensureListener();
    getWorker().postMessage({ type: 'write-bytes', jobId, opfsName, bytes }, [bytes]);
  });

const removeOpfs = (opfsName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingAck.set(jobId, { resolve, reject });
    send({ type: 'remove', jobId, opfsName });
  });

const cancelWorkerJob = (jobKey: string): void => {
  send({ type: 'cancel', jobKey });
};

const muxInWorker = (args: {
  jobKey: string;
  outputOpfsName: string;
  ffmpegArgs: string[];
  durationSeconds?: number;
  estimatedBytes?: number;
}): Promise<{ outputOpfsName: string; totalBytes: number }> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingMux.set(jobId, { resolve, reject });
    const req: MuxRequest = {
      type: 'mux',
      jobId,
      jobKey: args.jobKey,
      outputOpfsName: args.outputOpfsName,
      ffmpegArgs: args.ffmpegArgs,
      stage: 'mux',
      durationSeconds: args.durationSeconds,
      estimatedBytes: args.estimatedBytes,
    };
    send(req);
  });

export {
  fetchSegmentsToOpfs,
  fetchRangesToOpfs,
  fetchUrlToOpfs,
  getOpfsFile,
  writeBytesToOpfs,
  removeOpfs,
  cancelWorkerJob,
  muxInWorker,
};
