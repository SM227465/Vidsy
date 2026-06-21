/**
 * VK Video ISOLATED world script.
 *
 * Receives VK player params relayed from the MAIN world (see ./main.ts) and emits
 * a DETECTED candidate. VK exposes direct progressive MP4 URLs (url240 … url2160)
 * that already contain audio, so we surface them as HTTP quality variants — a
 * clean direct download that avoids VK's non-standard DASH and its MSE player.
 * Falls back to the `hls` master when no progressive URLs are present.
 */
import { MEDIA_MESSAGE } from '@extension/shared';
import { createBridge, onFromMain, sendToMain } from '@src/lib/broadcast-bridge';
import type { MediaVariant } from '@extension/shared';

// One candidate per video page (pathname); VK re-fetches params on quality
// switch / SPA nav with the same set, so the first payload wins per video.
const sentPaths = new Set<string>();

const getTitle = (md?: unknown): string => {
  if (typeof md === 'string' && md.trim()) return md.trim();
  return document.title.replace(/\s*[-—|]\s*(VK|ВК|VK Видео|VK Video).*$/i, '').trim() || document.title;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handleParams = (params: any, href: string) => {
  let path: string;
  try {
    path = new URL(href).pathname;
  } catch {
    path = href;
  }
  if (sentPaths.has(path)) return;

  // Direct progressive MP4s: urlNNN where NNN is the vertical resolution.
  const variants: MediaVariant[] = [];
  for (const key of Object.keys(params)) {
    const m = key.match(/^url(\d{3,4})$/);
    if (!m) continue;
    const url = params[key];
    if (typeof url !== 'string' || !url.startsWith('http')) continue;
    const h = Number(m[1]);
    variants.push({
      url,
      name: `${h}p`,
      // Width is unknown from the key; approximate 16:9 so the UI's shortEdge
      // label reads correctly ("720p" = min(w,h)).
      resolution: { width: Math.round((h * 16) / 9), height: h },
    });
  }
  variants.sort((a, b) => (b.resolution?.height ?? 0) - (a.resolution?.height ?? 0));

  const title = getTitle(params.md_title);
  // Relay the player's own title so the background can name the network-detected
  // DASH item — VK's <title>/og:title don't carry the video name on SPA nav.
  if (title) {
    chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.TITLE_HINT, payload: { title } }).catch(() => undefined);
  }

  if (variants.length > 0) {
    sentPaths.add(path);
    const best = variants[0];
    console.log('[Media Finder] VK: detected', { title, qualities: variants.map(v => v.name) });
    chrome.runtime
      .sendMessage({
        type: MEDIA_MESSAGE.DETECTED,
        payload: {
          url: best.url,
          kind: 'video' as const,
          mimeType: 'video/mp4',
          source: 'element' as const,
          title,
          resolution: best.resolution,
          variants: variants.length > 1 ? variants : undefined,
        },
      })
      .catch(() => undefined);
    return;
  }

  // No progressive URLs: deliberately do NOT emit VK's HLS here. VK's HLS is
  // video-only (audio is a separate EXT-X-MEDIA group we don't merge) and the
  // background already detects the complete DASH manifest — with audio AND a
  // resolution picker — so surfacing HLS too just duplicated the row with a
  // soundless option ("why 2"). VOD is covered by DASH; live needs its own path.
};

// ─── bridge wiring ───
const bridge = createBridge(window.location.origin + window.location.pathname);
onFromMain(bridge, msg => {
  if (msg.name === 'vk_params') {
    const data = msg.data as { params: unknown; href: string };
    if (data?.params) handleParams(data.params, data.href ?? location.href);
  }
});

// MAIN ran at document_start; ask it to re-scan any globals now that we're ready.
sendToMain(bridge, { name: 'vk_request_initial', data: null });

console.log('[Media Finder] VK Video extractor loaded');
