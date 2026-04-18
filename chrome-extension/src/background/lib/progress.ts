import { mediaDownloadsStorage } from '@extension/storage';
import type { MediaDownloadProgress, MediaDownloadState, MediaItem } from '@extension/shared';

type ProgressUpdate = {
  stage:
    | 'init'
    | 'fetch-manifest'
    | 'download-video'
    | 'download-audio'
    | 'mux'
    | 'finalize'
    | 'success'
    | 'failed'
    | 'cancelled'
    | 'paused';
  downloadedBytes: number;
  estimatedBytes?: number;
  error?: string;
  muxPercent?: number;
  downloadId?: number;
};

type ProgressContext = {
  item?: MediaItem;
  outputFormat?: 'mp4' | 'mp3';
};

export const updateProgress = async (key: string, progress: ProgressUpdate, context?: ProgressContext) => {
  const current = await mediaDownloadsStorage.get();
  const existing = current[key];
  const now = Date.now();
  const entry: MediaDownloadProgress = {
    key,
    stage: progress.stage,
    downloadedBytes: progress.downloadedBytes,
    estimatedBytes: progress.estimatedBytes ?? existing?.estimatedBytes,
    muxPercent: progress.muxPercent,
    error: progress.error,
    downloadId: progress.downloadId ?? existing?.downloadId,
    item: context?.item ?? existing?.item,
    outputFormat: context?.outputFormat ?? existing?.outputFormat,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  };
  const next: MediaDownloadState = { ...current, [key]: entry };
  await mediaDownloadsStorage.set(next);
};

export const clearProgress = async (key: string) => {
  await mediaDownloadsStorage.set(prev => {
    const next = { ...prev };
    delete next[key];
    return next;
  });
};

export const clearTerminalProgress = async (keys?: string[]) => {
  const TERMINAL = new Set(['success', 'failed', 'cancelled', 'paused']);
  await mediaDownloadsStorage.set(prev => {
    const next: MediaDownloadState = { ...prev };
    for (const [k, v] of Object.entries(prev)) {
      if (keys && !keys.includes(k)) continue;
      if (TERMINAL.has(v.stage)) delete next[k];
    }
    return next;
  });
};
