/**
 * VK Video MAIN world script.
 *
 * VK plays through its own player and fetches the video data via API; the
 * response carries the player params — direct progressive MP4 URLs (url240 …
 * url2160) and usually an `hls` master. Rather than hard-code VK's (changing)
 * API shape, we monkey-patch fetch + XHR and *recursively* locate the params
 * object inside any video-ish response, then relay it to the ISOLATED world
 * (which owns chrome.* and does the extraction). Must NOT use chrome.* here.
 */
import { createBridge, onFromIsolated, sendToIsolated } from '@src/lib/broadcast-bridge';

// Key the bridge on origin+pathname (stable per video; survives VK's SPA query
// rewrites), matching the ISOLATED side.
const channel = createBridge(window.location.origin + window.location.pathname);

// VK player-params signature: an object carrying at least one direct
// progressive URL (urlNNN) and/or an `hls` master playlist URL.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isVkParams = (node: any): boolean => {
  if (!node || typeof node !== 'object') return false;
  if (typeof node.hls === 'string' && node.hls) return true;
  return Object.keys(node).some(k => /^url\d{3,4}$/.test(k) && typeof node[k] === 'string');
};

// Walk an arbitrary API response to find the params object wherever VK wraps it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findVkParams = (node: any, depth = 0): any => {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (isVkParams(node)) return node;
  for (const key of Object.keys(node)) {
    const found = findVkParams(node[key], depth + 1);
    if (found) return found;
  }
  return null;
};

const relayParams = (params: unknown) => {
  sendToIsolated(channel, { name: 'vk_params', data: { params, href: location.href } });
};

const inspect = (json: unknown) => {
  try {
    const params = findVkParams(json);
    if (params) relayParams(params);
  } catch {
    /* not VK params — ignore */
  }
};

// Only bother parsing responses whose URL looks video-related — VK makes many
// unrelated API calls.
const looksVideo = (url: string): boolean => /video|al_video|playlist|player/i.test(url);

// ─── fetch sniffer ───
const originalFetch = window.fetch;
window.fetch = (...args: Parameters<typeof fetch>): Promise<Response> => {
  const promise = originalFetch.apply(window, args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input ?? '');
    if (looksVideo(url)) {
      promise
        .then(res => res.clone().json())
        .then(inspect)
        .catch(() => undefined);
    }
  } catch {
    /* never break the page's fetch */
  }
  return promise;
};

// ─── XHR sniffer ───
const originalOpen = XMLHttpRequest.prototype.open;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
XMLHttpRequest.prototype.open = function patchedOpen(this: any, method: string, url: string | URL, ...rest: any[]) {
  this.__vkUrl = typeof url === 'string' ? url : url.toString();

  return originalOpen.apply(this, [method, url, ...rest] as never);
};

const originalSend = XMLHttpRequest.prototype.send;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
XMLHttpRequest.prototype.send = function patchedSend(this: any, ...sendArgs: any[]) {
  this.addEventListener('load', () => {
    try {
      const url: string = this.__vkUrl ?? '';
      if (!looksVideo(url)) return;
      const rt = this.responseType;
      if (rt === '' || rt === 'text') inspect(JSON.parse(this.responseText));
      else if (rt === 'json' && this.response) inspect(this.response);
    } catch {
      /* non-JSON / cross-origin — ignore */
    }
  });
  return originalSend.apply(this, sendArgs as never);
};

// Some VK pages embed the params in a global at load (legacy embed path).
const scanGlobals = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  for (const key of ['playerParams', 'pl']) {
    if (w[key]) inspect(w[key]);
  }
};

onFromIsolated(channel, msg => {
  if (msg.name === 'vk_request_initial') scanGlobals();
});

scanGlobals();
