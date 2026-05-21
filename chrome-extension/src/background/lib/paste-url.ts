import { upsertDetection } from './detection';
import { deriveKind } from './media-utils';
import type { MediaKind, PasteUrlResult } from '@extension/shared';

// Hostnames where the page URL itself is what the user pastes — not a media URL.
// Vidsy cannot turn a watch-page URL into a downloadable stream (we'd need a
// site-specific extractor, which we explicitly do not ship — see
// project_competitor_deep_dive_2026_05). Reject early with a clear message.
const PAGE_HOSTS_NOT_SUPPORTED = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
]);

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const probeContentType = async (url: string): Promise<string | undefined> => {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'omit', redirect: 'follow' });
    if (!res.ok) return undefined;
    return res.headers.get('content-type') ?? undefined;
  } catch {
    return undefined;
  }
};

// Some servers reject HEAD or omit Content-Type. As a last resort, fetch the
// first 512 bytes — an HLS manifest starts with `#EXTM3U`, a DASH MPD has
// `<MPD` near the top, MP4 has `ftyp` at byte 4.
const peekFirstBytes = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      headers: { Range: 'bytes=0-511' },
      redirect: 'follow',
    });
    if (!res.ok && res.status !== 206) return null;
    const buf = await res.arrayBuffer();
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf).slice(0, 256));
  } catch {
    return null;
  }
};

const sniffKindFromHead = (head: string | null): MediaKind | undefined => {
  if (!head) return undefined;
  if (head.startsWith('#EXTM3U')) return 'hls';
  if (head.includes('<MPD') || head.includes('xmlns="urn:mpeg:dash:')) return 'dash';
  // MP4 has the 'ftyp' atom near the start (bytes 4-7 typically)
  if (head.includes('ftyp')) return 'video';
  return undefined;
};

export const classifyAndAddUrl = async (url: string, tabId?: number, pageUrl?: string): Promise<PasteUrlResult> => {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: 'No URL provided' };
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: 'URL must start with http:// or https://' };
  }

  const host = hostOf(trimmed);
  if (host && PAGE_HOSTS_NOT_SUPPORTED.has(host)) {
    return { ok: false, error: 'Vidsy cannot download from this site (Chrome Web Store rule)' };
  }

  // Phase 1: classify by URL extension alone (fast path)
  let kind: MediaKind = deriveKind(trimmed);

  // Phase 2: HEAD probe for Content-Type when extension didn't resolve
  if (kind === 'other') {
    const mime = await probeContentType(trimmed);
    if (mime) kind = deriveKind(trimmed, mime);
  }

  // Phase 3: content sniff (last resort for content-type-less responses)
  if (kind === 'other') {
    const head = await peekFirstBytes(trimmed);
    const sniffed = sniffKindFromHead(head);
    if (sniffed) kind = sniffed;
  }

  if (kind === 'other' || kind === 'mse' || kind === 'subtitle') {
    return {
      ok: false,
      error: "Couldn't recognise this URL as video, audio, HLS, or DASH",
    };
  }

  await upsertDetection({ url: trimmed, kind, source: 'element' }, tabId, pageUrl);

  return { ok: true, kind };
};
