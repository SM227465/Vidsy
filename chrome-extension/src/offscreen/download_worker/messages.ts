// Shared message protocol between the offscreen main thread and the download worker.
// The worker owns OPFS; the main thread still runs ffmpeg.wasm (mounts OPFS Files via WORKERFS).

import type { HlsKeyInfo } from '../lib/m3u8-parser';
import type { ChunkProgress } from '@extension/shared';

export type JobKey = string;

export type SegmentSpec = {
  url: string;
  keyInfo?: HlsKeyInfo;
  sequenceNumber: number;
};

export type FetchSegmentsRequest = {
  type: 'fetch-segments';
  jobId: string;
  jobKey: JobKey;
  opfsName: string;
  segments: SegmentSpec[];
  initUrl?: string;
  keyHeaders?: Record<string, string>;
  stage: 'download-video' | 'download-audio';
};

// Live recording: append a batch of newly-appeared segments to an EXISTING OPFS
// file (opens non-truncating, never removes on error) so the accumulator grows
// across many playlist polls. Distinct from fetch-segments, which truncates on
// open and is a one-shot VOD fetch.
export type AppendSegmentsRequest = {
  type: 'append-segments';
  jobId: string;
  jobKey: JobKey;
  opfsName: string;
  segments: SegmentSpec[];
  // Sent only on the first append of a recording (fMP4 init segment). The worker
  // writes it once, while the accumulator is still empty.
  initUrl?: string;
  keyHeaders?: Record<string, string>;
};

export type FetchUrlRequest = {
  type: 'fetch-url';
  jobId: string;
  jobKey: JobKey;
  opfsName: string;
  url: string;
  stage: 'download-video' | 'download-audio';
};

export type FetchRangesRequest = {
  type: 'fetch-ranges';
  jobId: string;
  jobKey: JobKey;
  opfsName: string;
  url: string;
  ranges: { start: number; end: number }[];
  totalBytes: number;
  stage: 'download-video' | 'download-audio';
  // Prior chunk states from a paused or interrupted run of this same key.
  // The worker uses these to skip dispatching chunks that already completed
  // (their bytes are already at the right offset in OPFS), so resume picks
  // up from the first incomplete chunk instead of restarting from byte 0.
  resumeChunks?: ChunkProgress[];
  // Cap on in-flight Range fetches for this job. Defaults to the worker's
  // MAX_CONCURRENT constant when not supplied. Clamped at receiver to [1, 16].
  maxConnections?: number;
};

export type GetFileRequest = {
  type: 'get-file';
  jobId: string;
  opfsName: string;
};

export type WriteBytesRequest = {
  type: 'write-bytes';
  jobId: string;
  opfsName: string;
  bytes: ArrayBuffer;
};

export type RemoveRequest = {
  type: 'remove';
  jobId: string;
  opfsName: string;
};

export type CancelRequest = {
  type: 'cancel';
  jobKey: JobKey;
};

export type MuxRequest = {
  type: 'mux';
  jobId: string;
  jobKey: JobKey;
  outputOpfsName: string;
  ffmpegArgs: string[];
  stage: 'mux';
  durationSeconds?: number;
  estimatedBytes?: number;
};

export type PingRequest = { type: 'ping' };

export type WorkerRequest =
  | FetchSegmentsRequest
  | AppendSegmentsRequest
  | FetchUrlRequest
  | FetchRangesRequest
  | GetFileRequest
  | WriteBytesRequest
  | RemoveRequest
  | CancelRequest
  | MuxRequest
  | PingRequest;

export type ProgressUpdate = {
  type: 'progress';
  jobKey: JobKey;
  stage: 'download-video' | 'download-audio' | 'mux';
  downloadedBytes: number;
  estimatedBytes?: number;
  muxPercent?: number;
  chunks?: ChunkProgress[];
};

export type FetchDone = {
  type: 'fetch-done';
  jobId: string;
  opfsName: string;
  totalBytes: number;
};

export type MuxDone = {
  type: 'mux-done';
  jobId: string;
  outputOpfsName: string;
  totalBytes: number;
};

export type GetFileDone = {
  type: 'get-file-done';
  jobId: string;
  file: File;
};

export type RemoveDone = {
  type: 'remove-done';
  jobId: string;
};

export type WorkerError = {
  type: 'error';
  jobId: string;
  error: string;
};

export type Pong = { type: 'pong' };

// Diagnostic log relayed from the worker (no chrome.* there) to the SW console
// via the offscreen worker-client.
export type WorkerLog = { type: 'log'; msg: string; data?: unknown };

export type WorkerResponse =
  | ProgressUpdate
  | FetchDone
  | MuxDone
  | GetFileDone
  | RemoveDone
  | WorkerError
  | Pong
  | WorkerLog;
