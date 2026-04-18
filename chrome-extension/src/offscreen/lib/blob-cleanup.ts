import { removeOpfs } from './worker-client';

// Tracks blob URLs whose underlying File is backed by an OPFS entry that must
// be removed once the browser-level chrome.downloads.download has completed.
// The SW reports completion via `offscreen/cleanup-blob`; we also fall back to
// a 5-minute timeout so an orphaned entry never lives forever.
const pending = new Map<string, { opfsName: string; timeout: ReturnType<typeof setTimeout> }>();

const FALLBACK_MS = 5 * 60_000;

export const registerOutputForCleanup = (blobUrl: string, opfsName: string): void => {
  const timeout = setTimeout(() => {
    void cleanupBlob(blobUrl);
  }, FALLBACK_MS);
  pending.set(blobUrl, { opfsName, timeout });
};

export const cleanupBlob = async (blobUrl: string): Promise<void> => {
  const entry = pending.get(blobUrl);
  if (!entry) return;
  pending.delete(blobUrl);
  clearTimeout(entry.timeout);
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
