// OPFS wrapper using FileSystemSyncAccessHandle (Worker-only API).
// The sync API is dramatically faster than the async one and avoids
// per-chunk promise overhead during segment streaming.

interface FileSystemSyncAccessHandleShim {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
interface FileSystemFileHandleWithSync extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandleShim>;
}

type Entry = {
  handle: FileSystemFileHandle;
  sync: FileSystemSyncAccessHandleShim;
  size: number;
};

export class OpfsWritableMap {
  private entries = new Map<string, Entry>();
  private root: FileSystemDirectoryHandle | null = null;

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    if (!this.root) this.root = await navigator.storage.getDirectory();
    return this.root;
  }

  async open(name: string): Promise<void> {
    if (this.entries.has(name)) return;
    const root = await this.getRoot();
    const handle = (await root.getFileHandle(name, { create: true })) as FileSystemFileHandleWithSync;
    const sync = await handle.createSyncAccessHandle();
    sync.truncate(0);
    this.entries.set(name, { handle, sync, size: 0 });
  }

  writeAt(name: string, pos: number, chunk: Uint8Array | ArrayBuffer): number {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`OPFS entry not open: ${name}`);
    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    let written = 0;
    while (written < view.byteLength) {
      const n = entry.sync.write(view.subarray(written), { at: pos + written });
      if (n <= 0) throw new Error(`OPFS write stalled at ${pos + written} (sync.write returned ${n})`);
      written += n;
    }
    if (pos + written > entry.size) entry.size = pos + written;
    return written;
  }

  append(name: string, chunk: Uint8Array | ArrayBuffer): number {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`OPFS entry not open: ${name}`);
    return this.writeAt(name, entry.size, chunk);
  }

  truncate(name: string, newSize: number): void {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`OPFS entry not open: ${name}`);
    entry.sync.truncate(newSize);
    entry.size = newSize;
  }

  size(name: string): number {
    return this.entries.get(name)?.size ?? 0;
  }

  async close(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;
    try {
      entry.sync.flush();
    } catch {
      /* ignore */
    }
    entry.sync.close();
    this.entries.delete(name);
  }

  async getFile(name: string): Promise<File> {
    // Must close the sync handle before reading through FileHandle.getFile.
    await this.close(name);
    const root = await this.getRoot();
    const handle = await root.getFileHandle(name);
    return handle.getFile();
  }

  async remove(name: string): Promise<void> {
    await this.close(name);
    try {
      const root = await this.getRoot();
      await root.removeEntry(name);
    } catch {
      /* ignore — already gone */
    }
  }

  async cleanupAll(): Promise<void> {
    for (const name of Array.from(this.entries.keys())) {
      try {
        await this.remove(name);
      } catch {
        /* ignore */
      }
    }
  }
}

export const opfs = new OpfsWritableMap();
