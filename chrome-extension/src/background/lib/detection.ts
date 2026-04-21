import { parseHlsVariants, parseDashVariants } from './manifest-parser';
import {
  createId,
  deriveKind,
  deriveFileName,
  htmlDecode,
  documentTitleFromUrl,
  isHlsSegment,
  isDashSegment,
  normalizeMediaUrl,
  MIN_MEDIA_SIZE_BYTES,
} from './media-utils';
import { mediaDetectionsStorage } from '@extension/storage';
import type { MediaItem, MediaVariant } from '@extension/shared';

// Convert a remote image URL to a data URL so it can be displayed in the popup
// (the popup has COEP: require-corp which blocks cross-origin image loads)
const fetchThumbnailAsDataUrl = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // Convert to base64 in chunks to avoid stack overflow
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
};

const seenUrlsByTab = new Map<number, Set<string>>();
const seenHlsMasterDirsByTab = new Map<number, Set<string>>();

const ensureSeenCache = (tabId?: number) => {
  if (tabId === undefined) return undefined;
  if (!seenUrlsByTab.has(tabId)) {
    seenUrlsByTab.set(tabId, new Set());
  }
  return seenUrlsByTab.get(tabId);
};

const ensureSeenMasterDirCache = (tabId?: number) => {
  if (tabId === undefined) return undefined;
  if (!seenHlsMasterDirsByTab.has(tabId)) {
    seenHlsMasterDirsByTab.set(tabId, new Set());
  }
  return seenHlsMasterDirsByTab.get(tabId);
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const dirKey = (url: string) => {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/');
    parts.pop();
    return `${parsed.origin}${parts.join('/')}/`;
  } catch {
    return undefined;
  }
};

const updateBadge = async (tabId: number, count: number) => {
  const text = count > 0 ? String(count) : '';
  try {
    await chrome.action.setBadgeText({ text, tabId });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#4c8dff', tabId });
    }
  } catch {
    // tab may no longer exist
  }
};

const normalizeDetection = (candidate: Partial<MediaItem>, tabId?: number, pageUrl?: string): MediaItem => {
  const kind = candidate.kind ?? deriveKind(candidate.url!, candidate.mimeType);
  return {
    id: candidate.id ?? createId(),
    url: candidate.url!,
    mimeType: candidate.mimeType,
    title: candidate.title ?? documentTitleFromUrl(pageUrl),
    pageUrl,
    tabId,
    detectedAt: candidate.detectedAt ?? Date.now(),
    source: candidate.source ?? 'element',
    fileName: candidate.fileName ?? deriveFileName(candidate.url!, candidate.title),
    contentLength: candidate.contentLength,
    kind,
    variants: candidate.variants,
    thumbnail: candidate.thumbnail,
    duration: candidate.duration,
    audioUrl: candidate.audioUrl,
    audioMimeType: candidate.audioMimeType,
    subtitles: candidate.subtitles,
    isDrmProtected: candidate.isDrmProtected,
  };
};

export const upsertDetection = async (candidate: Partial<MediaItem>, tabId?: number, pageUrl?: string) => {
  if (!candidate.url) return;

  // Normalize CDN byte-range URLs (e.g. Instagram's ?bytestart=...&byteend=...)
  // so each chunk of the same video collapses to a single entry and the
  // download target is the full-file URL.
  candidate.url = normalizeMediaUrl(candidate.url);

  // Convert remote thumbnail URLs to data URLs upfront
  if (candidate.thumbnail && !candidate.thumbnail.startsWith('data:')) {
    const dataUrl = await fetchThumbnailAsDataUrl(candidate.thumbnail);
    candidate.thumbnail = dataUrl ?? undefined;
  }

  const state = await mediaDetectionsStorage.get();
  const tabKey = tabId !== undefined ? String(tabId) : 'unknown';
  const current = state[tabKey] ?? [];
  const existingIdx = current.findIndex(item => item.url === candidate.url);

  if (existingIdx !== -1) {
    // Patch existing entry with richer data (thumbnail, duration, variants) if we now have it
    const existing = current[existingIdx];
    const patch: Partial<MediaItem> = {};
    if (candidate.thumbnail && !existing.thumbnail) patch.thumbnail = candidate.thumbnail;
    if (candidate.duration && !existing.duration) patch.duration = candidate.duration;
    if (candidate.variants?.length && !existing.variants?.length) patch.variants = candidate.variants;
    if (candidate.audioUrl && !existing.audioUrl) {
      patch.audioUrl = candidate.audioUrl;
      patch.audioMimeType = candidate.audioMimeType;
    }
    if (candidate.subtitles?.length && !existing.subtitles?.length) patch.subtitles = candidate.subtitles;
    if (
      candidate.title &&
      (!existing.title || existing.title === existing.pageUrl || existing.title?.match(/^[\w.-]+\.\w{2,}$/))
    ) {
      patch.title = candidate.title;
      // Always re-derive fileName from the updated title (regardless of what old fileName looks like)
      patch.fileName = deriveFileName(existing.url, candidate.title);
    }
    if (Object.keys(patch).length > 0) {
      const updatedList = [...current];
      updatedList[existingIdx] = { ...existing, ...patch };
      await mediaDetectionsStorage.set({ ...state, [tabKey]: updatedList });
    }
    return;
  }

  // Once an HLS/DASH manifest exists for this tab, treat any further video/audio
  // detections (element OR network) as player segments and suppress them — the
  // manifest is the downloadable artifact, individual segments are not.
  if (
    (candidate.kind === 'video' || candidate.kind === 'audio') &&
    current.some(item => item.kind === 'hls' || item.kind === 'dash')
  ) {
    return;
  }

  // Pair-detect Instagram-style adaptive delivery: two MP4 URLs on the same
  // host with matching duration are video-only + audio-only tracks of the
  // same stream. Collapse the second into the first as audioUrl so the
  // download path runs the V+A merge instead of saving two broken files.
  if (candidate.kind === 'video' && candidate.mimeType?.startsWith('video/') && candidate.duration) {
    const candidateHost = hostOf(candidate.url);
    if (candidateHost) {
      const mateIdx = current.findIndex(
        item =>
          item.kind === 'video' &&
          !item.audioUrl &&
          item.url !== candidate.url &&
          item.duration &&
          Math.abs(item.duration - (candidate.duration ?? 0)) < 0.5 &&
          hostOf(item.url) === candidateHost,
      );
      if (mateIdx !== -1) {
        const updatedList = [...current];
        updatedList[mateIdx] = {
          ...current[mateIdx],
          audioUrl: candidate.url,
          audioMimeType: candidate.mimeType,
        };
        await mediaDetectionsStorage.set({ ...state, [tabKey]: updatedList });
        if (tabId !== undefined) void updateBadge(tabId, updatedList.length);
        return;
      }
    }
  }

  const seenSet = ensureSeenCache(tabId);
  const normalized = normalizeDetection(candidate, tabId, pageUrl);
  // When an HLS/DASH manifest arrives, drop any pre-existing video/audio entries
  // for this tab — they are almost certainly player-side requests for the same
  // stream (Instagram, for example, fires progressive-MP4 requests before the MPD).
  const cleaned =
    normalized.kind === 'hls' || normalized.kind === 'dash'
      ? current.filter(item => item.kind !== 'video' && item.kind !== 'audio')
      : current;
  const updatedList = [normalized, ...cleaned].slice(0, 50);
  await mediaDetectionsStorage.set({ ...state, [tabKey]: updatedList });
  seenSet?.add(candidate.url);
  if (tabId !== undefined) {
    void updateBadge(tabId, updatedList.length);
    // Grab title, duration, and thumbnail from the tab via scripting
    chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => {
          // ─── Title (priority: JSON-LD > og:title > document.title with suffix stripped) ───
          let title: string | null = null;
          const ldScripts = document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]');
          for (const s of Array.from(ldScripts)) {
            try {
              const d = JSON.parse(s.textContent ?? '');
              const n = d?.name || d?.headline;
              if (n && typeof n === 'string' && n.length > 3) {
                title = n;
                break;
              }
            } catch {
              /* ignore */
            }
          }
          if (!title) {
            title = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? null;
          }
          if (!title) {
            title = document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.content ?? null;
          }
          if (!title) {
            title =
              document.title.replace(/\s*[-|\u2013\u2014]\s*[^-|\u2013\u2014]{1,40}$/, '') || document.title || null;
          }
          // Decode ALL HTML entities using the browser's native parser (textarea trick)
          if (title && title.includes('&')) {
            try {
              const _ta = document.createElement('textarea');
              _ta.innerHTML = title;
              title = _ta.value;
            } catch {
              /* keep as-is */
            }
          }

          // ─── Thumbnail (priority: JSON-LD > og:image > twitter:image) ───
          let thumbnail: string | null = null;
          for (const s of Array.from(ldScripts)) {
            try {
              const d = JSON.parse(s.textContent ?? '');
              const t = d?.thumbnailUrl || d?.thumbnail?.url || d?.image;
              if (t && typeof t === 'string') {
                thumbnail = t;
                break;
              }
              if (Array.isArray(d?.thumbnailUrl) && d.thumbnailUrl[0]) {
                thumbnail = d.thumbnailUrl[0];
                break;
              }
            } catch {
              /* ignore */
            }
          }
          if (!thumbnail)
            thumbnail = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ?? null;
          if (!thumbnail)
            thumbnail = document.querySelector<HTMLMetaElement>('meta[name="twitter:image"]')?.content ?? null;

          // ─── Duration (meta tags > largest visible video element) ───
          const durMeta =
            document.querySelector<HTMLMetaElement>('meta[property="video:duration"]')?.content ??
            document.querySelector<HTMLMetaElement>('meta[property="og:video:duration"]')?.content ??
            document.querySelector<HTMLMetaElement>('meta[itemprop="duration"]')?.content ??
            null;
          const videoDur = Array.from(document.querySelectorAll<HTMLVideoElement>('video'))
            .filter(v => {
              const r = v.getBoundingClientRect();
              return r.width > 200 && r.height > 150;
            })
            .map(v => v.duration)
            .filter(d => isFinite(d) && d > 0)
            .reduce((a, b) => Math.max(a, b), 0);
          const duration = durMeta ? parseFloat(durMeta) || null : videoDur > 0 ? videoDur : null;

          return { thumbnail, title, duration };
        },
      })
      .then(results => {
        const data = results?.[0]?.result;
        if (!data) return;
        const patch: Parameters<typeof upsertDetection>[0] = { url: normalized.url };
        if (data.thumbnail && !normalized.thumbnail) patch.thumbnail = data.thumbnail;
        // Update title if we have a better one — current title may be just a hostname
        if (data.title) {
          const decoded = htmlDecode(data.title);
          if (!normalized.title || normalized.title.match(/^[\w.-]+\.\w{2,}$/)) {
            patch.title = decoded;
          }
        }
        if (data.duration && !normalized.duration) patch.duration = data.duration;
        if (Object.keys(patch).length > 1) void upsertDetection(patch, tabId);
      })
      .catch(() => undefined);
  }
};

export const clearTabDetections = async (tabId: number) => {
  const state = await mediaDetectionsStorage.get();
  const tabKey = String(tabId);
  if (!state[tabKey]) return;
  const next = { ...state };
  delete next[tabKey];
  await mediaDetectionsStorage.set(next);
  seenUrlsByTab.delete(tabId);
  seenHlsMasterDirsByTab.delete(tabId);
  void updateBadge(tabId, 0);
};

export const handleNetworkDetection = async (details: chrome.webRequest.WebResponseHeadersDetails) => {
  const url = details.url;
  const tabId = details.tabId;
  if (tabId !== undefined && tabId < 0) return;
  // Skip data: and chrome-extension: URLs
  if (url.startsWith('data:') || url.startsWith('chrome-extension:') || url.startsWith('chrome:')) return;

  const contentType = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value;
  const contentLengthHeader = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-length')?.value;
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;

  // ── YouTube: intercept videoplayback segments and register each quality level once ──
  // YouTube MSE fetches byte-range chunks for each itag. Strip range params to get the
  // full-video base URL, then deduplicate by that URL across chunks.
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.endsWith('.googlevideo.com') && urlObj.pathname === '/videoplayback') {
      const itag = urlObj.searchParams.get('itag');
      if (!itag) return;
      // Only detect combined audio+video itags to avoid flooding with separate adaptive tracks.
      // 18 = 360p MP4, 22 = 720p MP4, 59 = 480p MP4, 78 = 480p MP4
      const COMBINED_ITAGS = new Set(['18', '22', '59', '78']);
      if (!COMBINED_ITAGS.has(itag)) return;
      // Derive a stable base URL by removing per-request byte-range parameters
      for (const p of ['range', 'rn', 'rbuf', 'sq', 'rqh']) urlObj.searchParams.delete(p);
      const baseUrl = urlObj.toString();
      const seenSet = ensureSeenCache(tabId);
      if (seenSet?.has(baseUrl)) return;
      let pageUrl = details.initiator;
      if (tabId !== undefined && tabId >= 0) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url) pageUrl = tab.url;
        } catch {
          // tab may not exist
        }
      }
      await upsertDetection(
        { url: baseUrl, kind: 'video', mimeType: contentType ?? 'video/mp4', source: 'network' },
        tabId,
        pageUrl,
      );
      return;
    }
  } catch {
    // ignore malformed URLs
  }

  const kind = deriveKind(url, contentType);
  if (kind === 'other') return;
  if (isHlsSegment(url, contentType)) return;
  if (isDashSegment(url, contentType)) return;

  // Skip small payloads for direct media (not manifests) — avoids tracker noise
  if ((kind === 'video' || kind === 'audio') && contentLength !== undefined && contentLength < MIN_MEDIA_SIZE_BYTES) {
    return;
  }

  let variants: MediaVariant[] | undefined;
  let isDrmProtected = false;
  if (kind === 'hls') {
    const parsed = await parseHlsVariants(url);
    variants = parsed.variants;
    isDrmProtected = parsed.isDrmProtected;
    if (variants && variants.length > 1) {
      variants = variants.slice().sort((a, b) => {
        const aRes = a.resolution?.height ?? 0;
        const bRes = b.resolution?.height ?? 0;
        if (aRes !== bRes) return bRes - aRes;
        const aBw = a.bandwidth ?? 0;
        const bBw = b.bandwidth ?? 0;
        return bBw - aBw;
      });
    }

    const dirSet = ensureSeenMasterDirCache(tabId);
    const directory = dirKey(url);
    if (directory) {
      if (dirSet?.has(directory)) return; // Already caught a playlist from this directory (likely the same video)
      dirSet?.add(directory);
    }
  }

  if (kind === 'dash') {
    const dirSet = ensureSeenMasterDirCache(tabId);
    const directory = dirKey(url);
    if (directory) {
      if (dirSet?.has(directory)) return;
      dirSet?.add(directory);
    }

    const parsed = await parseDashVariants(url);
    variants = parsed.variants;
    isDrmProtected = parsed.isDrmProtected;
    if (variants && variants.length > 1) {
      variants = variants.slice().sort((a, b) => {
        const aRes = a.resolution?.height ?? 0;
        const bRes = b.resolution?.height ?? 0;
        if (aRes !== bRes) return bRes - aRes;
        const aBw = a.bandwidth ?? 0;
        const bBw = b.bandwidth ?? 0;
        return bBw - aBw;
      });
    }
  }

  // Use actual tab URL (details.initiator is only the scheme+host, not the full path).
  let pageUrl = details.initiator;
  if (tabId !== undefined && tabId >= 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) pageUrl = tab.url;
    } catch {
      // tab may not exist
    }
  }

  await upsertDetection(
    {
      url,
      mimeType: contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      source: 'network',
      kind,
      variants,
      isDrmProtected: isDrmProtected || undefined,
    },
    tabId,
    pageUrl,
  );
};
