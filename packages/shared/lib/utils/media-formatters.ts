import type { MediaItem, MediaVariant } from './media.js';

const sanitizeFileNamePart = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

// Badge answers "what format am I downloading?" (MP4 / WEBM / HLS / DASH / MP3 …)
// rather than "is this media?". `+A` appended when a separate audio track is
// paired with a video-only stream (Instagram-style delivery).
const VIDEO_EXT_LABEL: Record<string, string> = {
  '.mp4': 'MP4',
  '.m4v': 'MP4',
  '.webm': 'WEBM',
  '.mov': 'MOV',
  '.mkv': 'MKV',
  '.flv': 'FLV',
  '.avi': 'AVI',
  '.ogv': 'OGV',
  '.3gp': '3GP',
  '.wmv': 'WMV',
};
const AUDIO_EXT_LABEL: Record<string, string> = {
  '.mp3': 'MP3',
  '.aac': 'AAC',
  '.m4a': 'M4A',
  '.ogg': 'OGG',
  '.opus': 'OPUS',
  '.flac': 'FLAC',
  '.wav': 'WAV',
  '.wma': 'WMA',
};

const pathExtension = (url: string): string => {
  try {
    const lastSegment = new URL(url).pathname.split('/').pop() ?? '';
    const dotIdx = lastSegment.lastIndexOf('.');
    return dotIdx >= 0 ? lastSegment.slice(dotIdx).toLowerCase() : '';
  } catch {
    return '';
  }
};

export type DownloadState = { busyUrl: string | null; error: string | null };

export const mediaBadgeLabel = (item: Pick<MediaItem, 'kind' | 'url' | 'mimeType' | 'audioUrl'>): string => {
  const mime = item.mimeType?.toLowerCase() ?? '';
  const ext = pathExtension(item.url);

  let base: string;
  if (item.kind === 'hls') base = 'HLS';
  else if (item.kind === 'dash') base = 'DASH';
  else if (item.kind === 'subtitle') base = 'CC';
  else if (item.kind === 'audio') base = AUDIO_EXT_LABEL[ext] ?? (mime.includes('mp3') ? 'MP3' : 'AUDIO');
  else if (item.kind === 'video') {
    base =
      VIDEO_EXT_LABEL[ext] ??
      (mime.includes('webm') ? 'WEBM' : mime.includes('mp4') ? 'MP4' : mime.includes('quicktime') ? 'MOV' : 'MP4');
  } else base = 'FILE';

  return item.kind === 'video' && item.audioUrl ? `${base}+A` : base;
};

export const kindBadgeColor = (kind: MediaItem['kind'], isLight: boolean): string => {
  const map: Record<string, string> = {
    hls: isLight ? 'bg-white/50 text-blue-900 ring-1 ring-white/40' : 'bg-black/40 text-blue-200 ring-1 ring-white/15',
    video: isLight
      ? 'bg-white/50 text-violet-900 ring-1 ring-white/40'
      : 'bg-black/40 text-violet-200 ring-1 ring-white/15',
    audio: isLight
      ? 'bg-white/50 text-emerald-900 ring-1 ring-white/40'
      : 'bg-black/40 text-emerald-200 ring-1 ring-white/15',
    dash: isLight
      ? 'bg-white/50 text-amber-900 ring-1 ring-white/40'
      : 'bg-black/40 text-amber-200 ring-1 ring-white/15',
    subtitle: isLight
      ? 'bg-white/50 text-pink-900 ring-1 ring-white/40'
      : 'bg-black/40 text-pink-200 ring-1 ring-white/15',
    other: isLight
      ? 'bg-white/50 text-gray-800 ring-1 ring-white/40'
      : 'bg-black/40 text-gray-200 ring-1 ring-white/15',
  };
  return map[kind] ?? map.other;
};

export const formatDuration = (secs: number): string => {
  if (!isFinite(secs) || secs <= 0) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const formatSpeed = (bps: number): string => {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
};

export const formatDate = (ts: number): string => {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

export const pickBestVariant = (variants: MediaVariant[]): MediaVariant | undefined =>
  variants.reduce<MediaVariant | undefined>((best, curr) => {
    if (!best) return curr;
    const bh = best.resolution?.height ?? 0;
    const ch = curr.resolution?.height ?? 0;
    if (ch !== bh) return ch > bh ? curr : best;
    return (curr.bandwidth ?? 0) > (best.bandwidth ?? 0) ? curr : best;
  }, undefined);

export const variantLabel = (v: MediaVariant): string => {
  if (v.resolution) return `${v.resolution.height}p`;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)}k`;
  return v.name ?? 'Auto';
};

export type FilenameTemplateContext = {
  title?: string;
  resolution?: string; // e.g. "1080p"
  ext?: string; // e.g. "mp4", "mp3" (no leading dot)
  kind?: MediaItem['kind'];
  host?: string;
  date?: string; // YYYY-MM-DD
};

export const buildFilenameContext = (
  item: Pick<MediaItem, 'title' | 'kind' | 'pageUrl' | 'url' | 'variants'>,
  opts: { resolution?: string; ext?: string; date?: Date } = {},
): FilenameTemplateContext => {
  const best = item.variants?.length ? pickBestVariant(item.variants) : undefined;
  const resolution = opts.resolution ?? (best?.resolution ? `${best.resolution.height}p` : undefined);
  let host: string | undefined;
  try {
    host = new URL(item.pageUrl ?? item.url).hostname.replace(/^www\./, '');
  } catch {
    host = undefined;
  }
  const d = opts.date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    title: item.title,
    resolution,
    ext: opts.ext,
    kind: item.kind,
    host,
    date,
  };
};

// Renders a filename template against a media item. Returns undefined when the
// template is empty or every token resolves to empty — callers should fall back
// to their default filename derivation in that case.
export const renderFilenameTemplate = (template: string, ctx: FilenameTemplateContext): string | undefined => {
  const tpl = template.trim();
  if (!tpl) return undefined;
  const tokens: Record<string, string | undefined> = {
    title: ctx.title,
    resolution: ctx.resolution,
    ext: ctx.ext,
    kind: ctx.kind,
    host: ctx.host,
    date: ctx.date,
  };
  const rendered = tpl.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = tokens[name];
    return value ? sanitizeFileNamePart(String(value)) : '';
  });
  // Collapse separators left behind by empty tokens (e.g. "title -- 1080p" → "title - 1080p")
  const collapsed = rendered
    .replace(/[\s_-]*-[\s_-]*-[\s_-]*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s_\-.]+|[\s_\-.]+$/g, '')
    .trim();
  return collapsed.length > 0 ? collapsed.slice(0, 180) : undefined;
};

export const FILENAME_TOKEN_HINT = '{title} {resolution} {ext} {kind} {host} {date}';
