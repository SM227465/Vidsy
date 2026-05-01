import { MEDIA_MESSAGE, stripTitleSuffix } from '@extension/shared';
import type { MediaKind } from '@extension/shared';

const sentUrls = new Set<string>();

// Presence of a rendered main-video element. Gates background network
// detections so listing pages (Instagram grid, feeds) don't flood the UI
// with phantom preloads. Only sent on transitions to keep the channel quiet.
let lastMainVideoPresent: boolean | null = null;

const publishMainVideoPresence = (present: boolean) => {
  if (present === lastMainVideoPresent) return;
  lastMainVideoPresent = present;
  chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.MAIN_VIDEO_PRESENT, payload: { present } }).catch(() => undefined);
};

const MAIN_VIDEO_MIN_W = 300;
const MAIN_VIDEO_MIN_H = 200;

const scanMainVideoPresence = () => {
  const elements = document.querySelectorAll<HTMLVideoElement>('video');
  for (const v of Array.from(elements)) {
    const rect = v.getBoundingClientRect();
    const style = window.getComputedStyle(v);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    if (rect.width >= MAIN_VIDEO_MIN_W && rect.height >= MAIN_VIDEO_MIN_H) {
      publishMainVideoPresence(true);
      return;
    }
  }
  publishMainVideoPresence(false);
};

/** Decode ALL HTML entities using the browser's native parser.
 *  Handles &period; → .  &amp; → &  &lpar; → (  &#123; → {  etc. */
const htmlDecode = (s: string): string => {
  if (!s.includes('&')) return s;
  try {
    const el = document.createElement('textarea');
    el.innerHTML = s;
    return el.value;
  } catch {
    return s;
  }
};

const isLikelyMediaUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // Skip URLs that are just the page itself (these download as HTML, not video)
    if (url === window.location.href) return false;
    // Skip URLs that look like HTML pages (no media extension, same origin path)
    const ext = parsed.pathname.split('.').pop()?.toLowerCase() ?? '';
    const htmlExts = ['html', 'htm', 'php', 'asp', 'aspx', 'jsp', ''];
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    // If URL has no file extension and looks like a page route, skip it
    if (htmlExts.includes(ext) && parsed.origin === window.location.origin) return false;
    // If URL path looks like a video page (e.g. /view_video.php, /video/123)
    if (
      pathSegments.some(s => /^(view_video|video|embed|watch)/.test(s)) &&
      !ext.match(/^(mp4|webm|mkv|m3u8|mpd|ts|m4s|mov|flv|avi|ogv|m4v)$/)
    )
      return false;
    return true;
  } catch {
    return false;
  }
};

const deriveKindFromElement = (el: HTMLMediaElement, url: string): MediaKind => {
  if (url.toLowerCase().endsWith('.m3u8')) return 'hls';
  return el.tagName.toLowerCase() === 'audio' ? 'audio' : 'video';
};

// ─── Main-video filtering ───
// Skip hover-preview videos and only detect the primary player.
// Hover previews are typically: small, short duration, or one of many videos on listing pages.

const isMainVideo = (el: HTMLVideoElement): boolean => {
  const rect = el.getBoundingClientRect();
  // Must be visible
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  if (rect.width === 0 || rect.height === 0) return false;

  // On pages with multiple video elements, only accept the largest one
  // (the main player is always the biggest; hover previews are smaller cards)
  const allVideos = Array.from(document.querySelectorAll<HTMLVideoElement>('video')).filter(v => {
    const r = v.getBoundingClientRect();
    const s = window.getComputedStyle(v);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  });

  if (allVideos.length > 1) {
    // Find the largest video by area
    const largest = allVideos.reduce((best, v) => {
      const r = v.getBoundingClientRect();
      const bestR = best.getBoundingClientRect();
      return r.width * r.height > bestR.width * bestR.height ? v : best;
    });
    if (el !== largest) return false;
  }

  // Minimum size threshold (very small videos are never the main player)
  if (rect.width < 300 || rect.height < 200) return false;

  return true;
};

// ─── Title extraction (priority order) ───
const getPageTitle = (): string => {
  // 1. JSON-LD structured data
  const ldScripts = document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]');
  for (const script of Array.from(ldScripts)) {
    try {
      const data = JSON.parse(script.textContent ?? '');
      const name = data?.name || data?.headline;
      if (name && typeof name === 'string' && name.length > 3) return htmlDecode(name);
    } catch {
      /* ignore */
    }
  }

  // 2. og:title (usually cleaner than document.title)
  const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content;
  if (ogTitle && ogTitle.length > 3) return htmlDecode(ogTitle);

  // 3. twitter:title
  const twTitle = document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.content;
  if (twTitle && twTitle.length > 3) return htmlDecode(twTitle);

  // 4. document.title with trailing site-name suffix stripped
  const title = stripTitleSuffix(document.title);
  return htmlDecode(title || document.title);
};

// ─── Thumbnail extraction ───
const MAX_THUMB_W = 320;

const captureVideoThumbnail = (el: HTMLVideoElement): string | undefined => {
  try {
    if (!el.videoWidth || !el.videoHeight || el.readyState < 2) return undefined;
    // Skip cross-origin videos (canvas taint)
    const scale = Math.min(1, MAX_THUMB_W / el.videoWidth);
    const w = Math.round(el.videoWidth * scale);
    const h = Math.round(el.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(el, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // Cross-origin taint or security error
    return undefined;
  }
};

const getPageThumbnail = (): string | undefined => {
  // 1. JSON-LD thumbnailUrl
  const ldScripts = document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]');
  for (const script of Array.from(ldScripts)) {
    try {
      const data = JSON.parse(script.textContent ?? '');
      const thumb = data?.thumbnailUrl || data?.thumbnail?.url || data?.image;
      if (thumb && typeof thumb === 'string') return thumb;
      if (Array.isArray(data?.thumbnailUrl) && data.thumbnailUrl[0]) return data.thumbnailUrl[0];
    } catch {
      /* ignore */
    }
  }

  // 2. og:image
  const og = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
  if (og) return og;

  // 3. twitter:image
  const tw = document.querySelector<HTMLMetaElement>('meta[name="twitter:image"]')?.content;
  if (tw) return tw;

  return undefined;
};

// ─── Duration extraction ───
const getPageDuration = (): number | undefined => {
  // From meta tags
  const durMeta =
    document.querySelector<HTMLMetaElement>('meta[property="video:duration"]')?.content ??
    document.querySelector<HTMLMetaElement>('meta[property="og:video:duration"]')?.content ??
    document.querySelector<HTMLMetaElement>('meta[itemprop="duration"]')?.content;
  if (durMeta) {
    const parsed = parseFloat(durMeta);
    if (isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
};

// ─── Candidate sending ───
const sendCandidate = (candidate: { url: string; mimeType?: string; kind?: MediaKind }, el?: HTMLMediaElement) => {
  if (!candidate.url || !isLikelyMediaUrl(candidate.url)) return;

  const isVideo = el instanceof HTMLVideoElement;

  // Main-video filter: skip tiny hover previews
  if (isVideo && !isMainVideo(el as HTMLVideoElement)) return;

  const duration = el && isFinite(el.duration) && el.duration > 0 ? el.duration : (getPageDuration() ?? undefined);
  const poster = isVideo && (el as HTMLVideoElement).poster ? (el as HTMLVideoElement).poster : undefined;
  const thumbnail = isVideo
    ? (captureVideoThumbnail(el as HTMLVideoElement) ?? poster ?? getPageThumbnail())
    : getPageThumbnail();

  const payload = {
    url: candidate.url,
    mimeType: candidate.mimeType,
    kind: candidate.kind,
    source: 'element' as const,
    title: getPageTitle(),
    duration,
    thumbnail,
  };

  // If already sent, only resend if we now have richer data
  if (sentUrls.has(candidate.url)) {
    if (thumbnail || duration) {
      chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.DETECTED, payload }).catch(() => undefined);
    }
    return;
  }

  sentUrls.add(candidate.url);
  chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.DETECTED, payload }).catch(() => undefined);
};

const collectFromElement = (el: HTMLMediaElement) => {
  const urls = new Set<string>();

  if (el.currentSrc) urls.add(el.currentSrc);
  if (el.src) urls.add(el.src);

  el.querySelectorAll('source').forEach(source => {
    if (source.src) urls.add(source.src);
  });

  urls.forEach(url => {
    const kind = deriveKindFromElement(el, url);
    const mimeType = el.getAttribute('type') ?? undefined;
    sendCandidate({ url, kind, mimeType }, el);
  });
};

const registerElement = (el: HTMLMediaElement) => {
  const handler = () => collectFromElement(el);
  ['loadedmetadata', 'canplay', 'play', 'durationchange', 'timeupdate'].forEach(event => {
    el.addEventListener(event, handler, { passive: true, once: event === 'timeupdate' });
  });
  handler();
};

const handleMutations = (mutations: MutationRecord[]) => {
  for (const mutation of mutations) {
    mutation.addedNodes.forEach(node => {
      if (!(node instanceof HTMLElement)) return;
      if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
        registerElement(node as HTMLMediaElement);
      }
      node.querySelectorAll?.('video, audio').forEach(el => registerElement(el as HTMLMediaElement));
    });

    if (mutation.type === 'attributes' && mutation.target instanceof HTMLMediaElement) {
      registerElement(mutation.target);
    }
  }
  // Cheap to rescan — the DOM just changed and a video may have mounted
  // (Instagram single-post navigation replaces the player in-place).
  scanMainVideoPresence();
};

export const initMediaDetector = () => {
  document.querySelectorAll<HTMLMediaElement>('video, audio').forEach(registerElement);
  scanMainVideoPresence();

  const observer = new MutationObserver(handleMutations);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  // Rescan on resize — elements can grow past the main-video threshold when
  // the player enters fullscreen or layout reflows.
  window.addEventListener('resize', scanMainVideoPresence, { passive: true });

  window.addEventListener('pagehide', () => {
    publishMainVideoPresence(false);
    chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CLEAR_TAB }).catch(() => undefined);
  });
};
