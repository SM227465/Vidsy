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

// ─── Queue persistence across service-worker restarts ───
// The queue lives in SW memory; a worker restart (crash, extension reload,
// browser killing an idle worker) would otherwise strand progress entries at
// stage 'queued' with nothing left to run them. Snapshot pending jobs into
// chrome.storage.session — it survives SW restarts and clears with the
// browser session, matching the session-scoped progress entries the UI
// renders — and rehydrate when the runner registers on SW startup.
const QUEUE_STORAGE_KEY = 'media-queue-snapshot';

const persistQueue = (): void => {
  chrome.storage.session.set({ [QUEUE_STORAGE_KEY]: pending }).catch(() => undefined);
};

const rehydrateQueue = async (): Promise<void> => {
  try {
    const res = await chrome.storage.session.get(QUEUE_STORAGE_KEY);
    const saved = res?.[QUEUE_STORAGE_KEY] as QueuedJob[] | undefined;
    if (!Array.isArray(saved) || saved.length === 0) return;
    for (const job of saved) {
      if (!job?.key || !job.payload || !job.item) continue;
      // A fresh enqueue may have raced ahead of this storage read — skip dupes.
      if (running.has(job.key) || pending.some(j => j.key === job.key)) continue;
      pending.push(job);
    }
    if (pending.length === 0) return;
    await refreshQueuePositions();
    void drain();
  } catch {
    // Snapshot unreadable — nothing to restore.
  }
};

// ─── Keep-alive while jobs are queued or running ───
// MV3 kills an idle SW after ~30s. Offscreen progress messages usually reset
// the idle timer during a download, but there are silent stretches (libav
// demuxing before the first output byte lands) that can exceed it — and a
// dead SW orphans the job: the offscreen mux finishes, but its response
// channel is gone and the final chrome.downloads.download never fires. Tick a
// cheap extension API call while anything is in flight; stop when the queue
// drains so the worker can sleep normally.
const KEEPALIVE_TICK_MS = 20_000;
let keepaliveHandle: ReturnType<typeof setInterval> | null = null;

const updateKeepalive = (): void => {
  const busy = running.size > 0 || pending.length > 0;
  if (busy && keepaliveHandle === null) {
    keepaliveHandle = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => undefined);
    }, KEEPALIVE_TICK_MS);
  } else if (!busy && keepaliveHandle !== null) {
    clearInterval(keepaliveHandle);
    keepaliveHandle = null;
  }
};

// Persist a 'queued' progress entry for every pending job, with 1-based position
// so the UI can render "Queued #2". Also clears positions on items that are
// no longer in the queue (e.g. just dequeued for running). Doubles as the
// single post-mutation hook: every queue change funnels through here, so the
// session snapshot stays in sync with one call site.
const refreshQueuePositions = async () => {
  persistQueue();
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
  updateKeepalive();
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
  updateKeepalive();
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
  // The SW just (re)started — restore any jobs a previous worker instance
  // left queued. Runs here (not at module eval) so the runner is guaranteed
  // to exist by the time drain() fires for the restored jobs.
  void rehydrateQueue();
};

// Diagnostics — used by tests and surfaceable in a future "queue depth" badge.
const queueState = () => ({
  pending: pending.map(j => j.key),
  running: Array.from(running),
});

export { cancelQueued, enqueueDownload, queueState, reorderQueueItem, setQueueRunner };
