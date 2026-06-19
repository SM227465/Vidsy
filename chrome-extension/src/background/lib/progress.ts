import { mediaDownloadsStorage, mediaResumablesStorage } from '@extension/storage';
import type {
  ChunkProgress,
  MediaDownloadProgress,
  MediaDownloadStage,
  MediaDownloadState,
  MediaItem,
} from '@extension/shared';

type ProgressUpdate = {
  stage: MediaDownloadStage;
  downloadedBytes: number;
  estimatedBytes?: number;
  error?: string;
  muxPercent?: number;
  downloadId?: number;
  chunks?: ChunkProgress[];
  queuePosition?: number;
};

type ProgressContext = {
  item?: MediaItem;
  outputFormat?: 'mp4' | 'mp3';
};

// All writes to mediaDownloadsStorage funnel through this chain. The storage
// wrapper's set() captures its cache snapshot before an internal await, so two
// interleaved writes — routine with downloadConcurrency > 1, where several
// jobs post progress at once — can silently drop each other's updates even
// when both use functional updaters. This module is the only writer (every
// progress mutation goes through the SW), so chaining here closes the window.
let writeChain: Promise<void> = Promise.resolve();
const enqueueWrite = (fn: () => Promise<void>): Promise<void> => {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
};

export const updateProgress = async (key: string, progress: ProgressUpdate, context?: ProgressContext) =>
  enqueueWrite(async () => {
    const now = Date.now();
    await mediaDownloadsStorage.set(prev => {
      const existing = prev[key];
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
        // Deliberately NOT merged from `existing` — the position is only
        // meaningful while stage === 'queued', and the first non-queued write
        // (e.g. 'init' when the job starts running) must clear it.
        queuePosition: progress.queuePosition,
      };
      return { ...prev, [key]: entry };
    });
  });

export const clearProgress = async (key: string) =>
  enqueueWrite(async () => {
    await mediaDownloadsStorage.set(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  });

export const clearTerminalProgress = async (keys?: string[]) => {
  const TERMINAL = new Set(['success', 'failed', 'cancelled', 'paused']);
  const cleared: string[] = [];
  await enqueueWrite(async () => {
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
