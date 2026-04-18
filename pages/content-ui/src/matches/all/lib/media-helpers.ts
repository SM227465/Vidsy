import type { MediaItem, MediaVariant } from '@extension/shared';

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
  v.resolution ? `${v.resolution.height}p` : v.bandwidth ? `${Math.round(v.bandwidth / 1000)}k` : (v.name ?? '');

export const kindStr = (k: string): string =>
  k === 'hls' ? 'HLS' : k === 'dash' ? 'DASH' : k === 'audio' ? 'Audio' : 'MP4';

export const formatBytes = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
};

export const formatSeconds = (sec?: number): string => {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
};

type Row = { label: string; sub: string; item: MediaItem; variantUrl?: string };

export const buildRows = (items: MediaItem[]): Row[] => {
  const rows: Row[] = [];
  let i = 1;
  for (const item of items) {
    const title = (item.title ?? item.fileName ?? 'Video').slice(0, 44);
    const kt = kindStr(item.kind);
    const size = formatBytes(item.contentLength);
    const duration = formatSeconds(item.duration);

    const parts = [kt, duration, size].filter(Boolean);
    const baseInfo = parts.join(' · ');

    if (item.variants?.length) {
      for (const v of item.variants)
        rows.push({ label: `${i++}. ${title}`, sub: `${baseInfo} · ${qLabel(v)}`, item, variantUrl: v.url });
    } else {
      rows.push({ label: `${i++}. ${title}`, sub: baseInfo, item, variantUrl: undefined });
    }
  }
  return rows;
};
