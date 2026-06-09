import { mediaDownloadsStorage, mediaResumablesStorage } from '@extension/storage';
import type { ChunkProgress, MediaDownloadProgress, MediaDownloadState, MediaItem } from '@extension/shared';

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
  chunks?: ChunkProgress[];
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
    chunks: progress.chunks ?? existing?.chunks,
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
  const cleared: string[] = [];
  await mediaDownloadsStorage.set(prev => {
    const next: MediaDownloadState = { ...prev };
    for (const [k, v] of Object.entries(prev)) {
      if (keys && !keys.includes(k)) continue;
      if (TERMINAL.has(v.stage)) {
        delete next[k];
        cleared.push(k);
      }
    }
    return next;
  });
  if (cleared.length === 0) return;
  // Drop any cross-session resume manifests for the keys we just cleared.
  // Without this, a "cleared" paused download would reappear next session as
  // a hydrated paused row from mediaResumablesStorage.
  void mediaResumablesStorage
    .set(prev => {
      let mutated = false;
      const next = { ...prev };
      for (const k of cleared) {
        if (k in next) {
          delete next[k];
          mutated = true;
        }
      }
      return mutated ? next : prev;
    })
    .catch(() => undefined);
};
