import { updateProgress, clearProgress } from './progress';
import { mediaSettingsStorage } from '@extension/storage';
import type { MediaItem, MediaMessage } from '@extension/shared';

// Concurrency is user-configurable via the options page (default 1). libav
// HLS/DASH muxes are RAM- and OPFS-bandwidth-heavy; higher values trade
// stability for throughput. Clamped to [1, 8].
const readConcurrency = async (): Promise<number> => {
  const settings = await mediaSettingsStorage.get();
  const raw = settings.downloadConcurrency ?? 1;
  return Math.max(1, Math.min(8, Math.floor(raw)));
};

type DownloadPayload = Extract<MediaMessage, { type: 'media/download' }>['payload'];
type Runner = (payload: DownloadPayload) => Promise<unknown>;

type QueuedJob = {
  key: string;
  payload: DownloadPayload;
  item: MediaItem;
};

const pending: QueuedJob[] = [];
const running = new Set<string>();
let runner: Runner | null = null;

// Persist a 'queued' progress entry for every pending job, with 1-based position
// so the UI can render "Queued #2". Also clears positions on items that are
// no longer in the queue (e.g. just dequeued for running).
const refreshQueuePositions = async () => {
  for (let i = 0; i < pending.length; i++) {
    const job = pending[i];
    await updateProgress(
      job.key,
      { stage: 'queued', downloadedBytes: 0, queuePosition: i + 1 },
      { item: job.item, outputFormat: job.payload.outputFormat ?? 'mp4' },
    );
  }
};

const drain = async (): Promise<void> => {
  if (!runner) return;
  const concurrency = await readConcurrency();
  while (running.size < concurrency && pending.length > 0) {
    const job = pending.shift();
    if (!job) break;
    running.add(job.key);
    await refreshQueuePositions();
    // Fire-and-forget — drain() returns after kicking off the runner. The
    // runner's `finally` clears `running` and re-enters drain.
    void runner(job.payload)
      .catch(() => undefined)
      .finally(() => {
        running.delete(job.key);
        void drain();
      });
  }
};

const enqueueDownload = async (payload: DownloadPayload, item: MediaItem): Promise<void> => {
  const key = payload.key ?? payload.url;

  // De-dupe: if a job with this key is already queued or running, ignore the
  // new request. The popup's progress UI already reflects the existing state.
  if (running.has(key) || pending.some(j => j.key === key)) {
    return;
  }

  pending.push({ key, payload, item });
  await refreshQueuePositions();
  void drain();
};

const cancelQueued = async (key: string): Promise<boolean> => {
  const idx = pending.findIndex(j => j.key === key);
  if (idx === -1) return false;
  pending.splice(idx, 1);
  await clearProgress(key);
  await refreshQueuePositions();
  return true;
};

const reorderQueueItem = async (key: string, direction: 'up' | 'down'): Promise<boolean> => {
  const idx = pending.findIndex(j => j.key === key);
  if (idx === -1) return false;
  const newIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= pending.length) return false;
  [pending[idx], pending[newIdx]] = [pending[newIdx], pending[idx]];
  await refreshQueuePositions();
  return true;
};

const setQueueRunner = (fn: Runner) => {
  runner = fn;
};

// Diagnostics — used by tests and surfaceable in a future "queue depth" badge.
const queueState = () => ({
  pending: pending.map(j => j.key),
  running: Array.from(running),
});

export { cancelQueued, enqueueDownload, queueState, reorderQueueItem, setQueueRunner };
