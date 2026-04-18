// Shared message protocol between the offscreen main thread and the download worker.
// The worker owns OPFS; the main thread still runs ffmpeg.wasm (mounts OPFS Files via WORKERFS).

import type { HlsKeyInfo } from '../lib/m3u8-parser';

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

export type WorkerResponse = ProgressUpdate | FetchDone | MuxDone | GetFileDone | RemoveDone | WorkerError | Pong;
