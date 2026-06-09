import { createStorage, StorageEnum } from '../base/index.js';

// Local type copies — keeps this package free of @extension/shared (which depends
// on @extension/storage). Consumers import the canonical ResumeManifest /
// MediaResumablesState from @extension/shared.

type LocalChunkProgress = {
  i: number;
  start: number;
  end: number;
  downloaded: number;
  status: 'pending' | 'fetching' | 'done' | 'error';
};

// item is persisted verbatim from MediaItem in @extension/shared. We carry it
// opaque here because (a) MediaItem has a large nested shape and (b) storage
// never introspects it — only the popup / background hand it back to the
// download dispatcher on Resume.
type ResumeManifestRecord = {
  key: string;
  url: string;
  fileName?: string;
  title?: string;
  item: unknown;
  outputFormat?: 'mp4' | 'mp3';
  // OPFS filename produced by opfsNameFor(key, 'in', 'bin') in http-download.ts.
  // The GC sparing pass uses this to skip deletion of the file on offscreen-doc
  // startup.
  opfsName: string;
  totalBytes: number;
  ranges: { start: number; end: number }[];
  // Only chunks marked status === 'done' contribute to byte-level resume; we
  // keep all of them to preserve the position-bar visualization across sessions.
  chunks: LocalChunkProgress[];
  downloadedBytes: number;
  pausedAt: number;
  expiresAt: number;
};

type MediaResumablesRecord = Record<string, ResumeManifestRecord>;

export const mediaResumablesStorage = createStorage<MediaResumablesRecord>(
  'media-resumables',
  {},
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);
