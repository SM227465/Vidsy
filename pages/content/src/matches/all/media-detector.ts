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
  const videos = document.querySelectorAll<HTMLVideoElement>('video');
  for (const v of Array.from(videos)) {
    const rect = v.getBoundingClientRect();
    const style = window.getComputedStyle(v);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    if (rect.width >= MAIN_VIDEO_MIN_W && rect.height >= MAIN_VIDEO_MIN_H) {
      publishMainVideoPresence(true);
      return;
    }
  }
  // Audio-only pages (freefy, soundcloud-style players) never satisfy the
  // video size threshold but still have legitimate playable media. Treat any
  // <audio> element that has loaded metadata (duration known) as main media so
  // network audio/HLS detections aren't gated out on these tabs.
  const audios = document.querySelectorAll<HTMLAudioElement>('audio');
  for (const a of Array.from(audios)) {
    if ((isFinite(a.duration) && a.duration > 0) || a.currentSrc || a.src) {
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
  // Synthetic identifier for MSE-fed players where the real source is a
  // per-page-load blob: URL we can't fetch — passes through so the UI can
  // surface an "MSE" badge.
  if (url.startsWith('mse:')) return true;
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
  if (url.startsWith('blob:')) return 'mse';
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

// ─── Metadata probe for non-rendered URLs ───
// When a page exposes multiple HTTP sources (e.g. HD + SD download links),
// the live <video> element only tells us the resolution of whichever source
// is currently playing. To learn the others' resolutions without making the
// user toggle quality, load each in a detached <video preload="metadata">.
// Browsers fetch only a few hundred KB to expose videoWidth/videoHeight.
const PROBE_TIMEOUT_MS = 15_000;
const probedUrls = new Set<string>();
const probeUrlForResolution = (url: string) => {
  if (probedUrls.has(url) || !url.startsWith('http')) return;
  probedUrls.add(url);
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.muted = true;
  // No crossOrigin attribute — videoWidth/videoHeight are exposed without CORS,
  // and many servers (lolpol, similar) don't send Access-Control-Allow-Origin,
  // which would otherwise block the probe entirely.
  probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    probe.removeAttribute('src');
    try {
      probe.load();
    } catch {
      /* noop */
    }
    probe.remove();
  };
  probe.addEventListener(
    'loadedmetadata',
    () => {
      if (probe.videoWidth > 0 && probe.videoHeight > 0) {
        chrome.runtime
          .sendMessage({
            type: MEDIA_MESSAGE.DETECTED,
            payload: {
              url,
              source: 'element',
              resolution: { width: probe.videoWidth, height: probe.videoHeight },
              duration: isFinite(probe.duration) && probe.duration > 0 ? probe.duration : undefined,
            },
          })
          .catch(() => undefined);
      }
      cleanup();
    },
    { once: true },
  );
  probe.addEventListener('error', cleanup, { once: true });
  setTimeout(cleanup, PROBE_TIMEOUT_MS);
  probe.src = url;
  document.body.appendChild(probe);
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
  const videoEl = isVideo ? (el as HTMLVideoElement) : undefined;
  // Only trust the live element's resolution for the URL it is actually
  // rendering. Other source URLs (e.g. alt-quality <source> tags) need their
  // own probe — we'd otherwise mislabel HD with SD's dimensions or vice versa.
  const isRendered = videoEl && (videoEl.currentSrc === candidate.url || videoEl.src === candidate.url);
  const resolution =
    isRendered && videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0
      ? { width: videoEl.videoWidth, height: videoEl.videoHeight }
      : undefined;

  const payload = {
    url: candidate.url,
    mimeType: candidate.mimeType,
    kind: candidate.kind,
    source: 'element' as const,
    title: getPageTitle(),
    duration,
    thumbnail,
    resolution,
  };

  // If already sent, only resend if we now have richer data
  if (sentUrls.has(candidate.url)) {
    if (thumbnail || duration || resolution) {
      chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.DETECTED, payload }).catch(() => undefined);
    }
    return;
  }

  sentUrls.add(candidate.url);
  chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.DETECTED, payload }).catch(() => undefined);

  // Kick off a metadata probe for non-rendered HTTP video URLs so their
  // resolution lands on a follow-up detection.
  if (isVideo && !isRendered && candidate.kind !== 'hls' && candidate.kind !== 'dash' && candidate.kind !== 'mse') {
    probeUrlForResolution(candidate.url);
  }
};

const collectFromElement = (el: HTMLMediaElement) => {
  const urls = new Set<string>();
  let blobSrc: string | undefined;

  for (const u of [el.currentSrc, el.src]) {
    if (!u) continue;
    if (u.startsWith('blob:')) blobSrc = u;
    else urls.add(u);
  }

  el.querySelectorAll('source').forEach(source => {
    if (source.src && !source.src.startsWith('blob:')) urls.add(source.src);
  });

  // Modern MSE pattern: the MediaSource is bound via `srcObject` directly,
  // skipping URL.createObjectURL entirely — so both el.src and el.currentSrc
  // are empty. We can't fetch this either, but the MSE label tells the user
  // we at least saw the media.
  const srcObjectBound = 'srcObject' in el && (el as HTMLMediaElement & { srcObject: unknown }).srcObject != null;

  if (
    urls.size === 0 &&
    (blobSrc || srcObjectBound) &&
    (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement)
  ) {
    // MSE-fed player: source is bound to this document only (blob URL or
    // direct srcObject) and we can't fetch it. Register an MSE label so the
    // UI shows the media instead of silently dropping it. The download action
    // is blocked downstream.
    sendCandidate({ url: `mse:${window.location.href}`, kind: 'mse' }, el);
    return;
  }

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
