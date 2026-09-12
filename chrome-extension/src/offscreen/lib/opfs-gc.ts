// Startup garbage collection for the Origin Private File System.
//
// Any files present at offscreen-doc init are orphans from a prior
// session (crash, browser kill, extension reload). The offscreen doc
// owns OPFS for the lifetime of every download — if it restarted, the
// worker died with it, so no in-flight download could have survived.
//
// Sprint 11: paused HTTP-range downloads are now resumable across browser
// sessions. We spare their OPFS scratch files (identified by the opfsName
// recorded in mediaResumablesStorage) as long as the manifest hasn't
// expired. Expired manifests are dropped here too so the storage doesn't
// accumulate stale entries.

type DirHandleWithKeys = FileSystemDirectoryHandle & {
  keys(): AsyncIterableIterator<string>;
};

export const purgeOpfsOrphans = async (): Promise<{ removed: number; failed: number; spared: number }> => {
  let removed = 0;
  let failed = 0;
  let spared = 0;

  // Read resumable manifests + drop expired ones up front, so the protected
  // set reflects only still-valid paused downloads.
  const { mediaResumablesStorage } = await import('@extension/storage').catch(() => ({
    mediaResumablesStorage: undefined,
  }));
  const protectedNames = new Set<string>();
  if (mediaResumablesStorage) {
    try {
      const now = Date.now();
      const all = await mediaResumablesStorage.get();
      const expiredKeys: string[] = [];
      for (const [key, manifest] of Object.entries(all)) {
        if (manifest.expiresAt <= now) {
          expiredKeys.push(key);
        } else {
          protectedNames.add(manifest.opfsName);
        }
      }
      if (expiredKeys.length > 0) {
        await mediaResumablesStorage.set(prev => {
          const next = { ...prev };
          for (const k of expiredKeys) delete next[k];
          return next;
        });
      }
    } catch (err) {
      console.warn('[Vidsy] OPFS GC: resumables read failed (proceeding without sparing):', err);
    }
  }

  try {
    const root = (await navigator.storage.getDirectory()) as DirHandleWithKeys;
    const names: string[] = [];
    // Enumerate first, then delete — avoid mutating while iterating.
    for await (const name of root.keys()) {
      names.push(name);
    }
    for (const name of names) {
      if (protectedNames.has(name)) {
        spared++;
        continue;
      }
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
  return { removed, failed, spared };
};
