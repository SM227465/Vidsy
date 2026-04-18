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
          const { jobKey, stage, downloadedBytes, estimatedBytes, muxPercent } = msg as ProgressUpdate;
          void updateProgress(jobKey, { stage, downloadedBytes, estimatedBytes, muxPercent });
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

export const fetchSegmentsToOpfs = (args: {
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

export const fetchRangesToOpfs = (args: {
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
    const req: FetchRangesRequest = { type: 'fetch-ranges', jobId, ...args };
    send(req);
  });

export const fetchUrlToOpfs = (args: {
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

export const getOpfsFile = (opfsName: string): Promise<File> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFile.set(jobId, { resolve, reject });
    send({ type: 'get-file', jobId, opfsName });
  });

export const writeBytesToOpfs = (opfsName: string, bytes: ArrayBuffer): Promise<File> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingFile.set(jobId, { resolve, reject });
    ensureListener();
    getWorker().postMessage({ type: 'write-bytes', jobId, opfsName, bytes }, [bytes]);
  });

export const removeOpfs = (opfsName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const jobId = nextJobId();
    pendingAck.set(jobId, { resolve, reject });
    send({ type: 'remove', jobId, opfsName });
  });

export const cancelWorkerJob = (jobKey: string): void => {
  send({ type: 'cancel', jobKey });
};

export const muxInWorker = (args: {
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
