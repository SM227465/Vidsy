// Startup garbage collection for the Origin Private File System.
//
// Any files present at offscreen-doc init are orphans from a prior
// session (crash, browser kill, extension reload). The offscreen doc
// owns OPFS for the lifetime of every download — if it restarted, the
// worker died with it, so no in-flight download could have survived.
// Safe to wipe everything.

type DirHandleWithKeys = FileSystemDirectoryHandle & {
  keys(): AsyncIterableIterator<string>;
};

export const purgeOpfsOrphans = async (): Promise<{ removed: number; failed: number }> => {
  let removed = 0;
  let failed = 0;
  try {
    const root = (await navigator.storage.getDirectory()) as DirHandleWithKeys;
    const names: string[] = [];
    // Enumerate first, then delete — avoid mutating while iterating.
    for await (const name of root.keys()) {
      names.push(name);
    }
    for (const name of names) {
      try {
        await root.removeEntry(name, { recursive: true });
        removed++;
      } catch {
        failed++;
      }
    }
  } catch (err) {
    console.warn('[Vidsy] OPFS GC failed:', err);
  }
  return { removed, failed };
};
