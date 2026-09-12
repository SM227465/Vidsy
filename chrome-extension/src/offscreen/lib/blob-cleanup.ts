import { removeOpfs } from './worker-client';

// Tracks blob URLs whose underlying File is backed by an OPFS entry that must
// be removed once the browser-level chrome.downloads.download has completed.
// The SW reports completion via `offscreen/cleanup-blob`. The fallback timer
// only covers outputs the SW never claimed (its chrome.downloads.download call
// failed before producing an id) — once the SW tracks the download it sends
// `offscreen/disarm-cleanup`, because a multi-GB copy to a slow disk can
// outlast any fixed timeout and destroying the OPFS backing mid-copy corrupts
// the saved file.
const pending = new Map<string, { opfsName: string; timeout: ReturnType<typeof setTimeout> | null }>();

const FALLBACK_MS = 10 * 60_000;

export const registerOutputForCleanup = (blobUrl: string, opfsName: string): void => {
  const timeout = setTimeout(() => {
    void cleanupBlob(blobUrl);
  }, FALLBACK_MS);
  pending.set(blobUrl, { opfsName, timeout });
};

// The SW tracked the downloadId for this blob — cleanup will arrive via the
// downloads.onChanged path, so the orphan fallback must stand down.
export const disarmCleanupFallback = (blobUrl: string): void => {
  const entry = pending.get(blobUrl);
  if (!entry?.timeout) return;
  clearTimeout(entry.timeout);
  entry.timeout = null;
};

export const cleanupBlob = async (blobUrl: string): Promise<void> => {
  const entry = pending.get(blobUrl);
  if (!entry) return;
  pending.delete(blobUrl);
  if (entry.timeout) clearTimeout(entry.timeout);
  try {
    URL.revokeObjectURL(blobUrl);
  } catch {
    /* ignore */
  }
  try {
    await removeOpfs(entry.opfsName);
  } catch {
    /* ignore */
  }
};
