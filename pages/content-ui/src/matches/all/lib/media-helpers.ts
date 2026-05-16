import type { MediaItem, MediaVariant } from '@extension/shared';

// "Nnnnp" conventionally names the short edge (1080p = 1920×1080 landscape or
// 1080×1920 portrait), not whichever side happens to be the height field.
const shortEdgeLabel = (r: { width: number; height: number }) => `${Math.min(r.width, r.height)}p`;

type Row = { label: string; sub: string; item: MediaItem; variantUrl?: string };

const topLevelQuality = (item: MediaItem): string => (item.resolution ? shortEdgeLabel(item.resolution) : '');

export type VideoEntry = { el: HTMLVideoElement; id: string; rect: DOMRect };

export const ACTIVE_STAGES = new Set(['init', 'fetch-manifest', 'download-video', 'download-audio', 'mux', 'finalize']);

export const pickBestVariant = (vs: MediaVariant[]): MediaVariant | undefined =>
  vs.reduce<MediaVariant | undefined>((b, c) => {
    if (!b) return c;
    const bh = b.resolution?.height ?? 0,
      ch = c.resolution?.height ?? 0;
    if (ch !== bh) return ch > bh ? c : b;
    return (c.bandwidth ?? 0) > (b.bandwidth ?? 0) ? c : b;
  }, undefined);

export const qLabel = (v: MediaVariant): string =>
  v.resolution ? shortEdgeLabel(v.resolution) : v.bandwidth ? `${Math.round(v.bandwidth / 1000)}k` : (v.name ?? '');

export const kindStr = (k: string): string => {
  switch (k) {
    case 'hls':
      return 'HLS';
    case 'dash':
      return 'DASH';
    case 'mss':
      return 'MSS';
    case 'mse':
      return 'MSE';
    default:
      return 'HTTP';
  }
};

export const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
};

// bandwidth (bits/s) × duration (s) ÷ 8 → bytes. Used for HLS/DASH variants
// where the manifest declares bitrate but not an exact size.
export const estimateBytes = (bandwidth?: number, durationSec?: number): number | undefined => {
  if (!bandwidth || bandwidth <= 0 || !durationSec || durationSec <= 0) return undefined;
  return (bandwidth * durationSec) / 8;
};

export const formatSeconds = (sec?: number): string => {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
};

export const buildRows = (items: MediaItem[]): Row[] => {
  const rows: Row[] = [];
  let i = 1;
  for (const item of items) {
    const title = (item.title ?? item.fileName ?? 'Video').slice(0, 44);
    const kt = kindStr(item.kind);
    const duration = formatSeconds(item.duration);

    if (item.variants?.length) {
      for (const v of item.variants) {
        // Prefer exact size (HTTP variants from HEAD/response); fall back to
        // bandwidth × duration estimate (HLS/DASH) with a `~` marker.
        let sizeStr = '';
        if (v.contentLength) {
          sizeStr = formatBytes(v.contentLength);
        } else {
          const est = formatBytes(estimateBytes(v.bandwidth, item.duration));
          if (est) sizeStr = `~${est}`;
        }
        const parts = [kt, duration, sizeStr, qLabel(v)].filter(Boolean);
        rows.push({ label: `${i++}. ${title}`, sub: parts.join(' · '), item, variantUrl: v.url });
      }
    } else {
      const size = formatBytes(item.contentLength);
      const q = topLevelQuality(item);
      const parts = [kt, duration, size, q].filter(Boolean);
      rows.push({ label: `${i++}. ${title}`, sub: parts.join(' · '), item, variantUrl: undefined });
    }
  }
  return rows;
};
