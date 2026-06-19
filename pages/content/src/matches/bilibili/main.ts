/**
 * Bilibili MAIN world script.
 *
 * Bilibili plays through MSE, so there is no fetchable <video> source. The real
 * streams live in the page's `playurl` payload:
 *   - bilibili.com  → `window.__playinfo__` on first SSR load, then the SPA
 *                     re-fetches `…/x/player/wbi/playurl` on every navigation.
 *   - bilibili.tv   → `…/intl/gateway/web/playurl` (and ogv variants).
 *
 * We read the SSR globals on load and monkey-patch fetch + XHR to capture the
 * fresh payload on every SPA navigation / quality switch, then relay the raw
 * JSON to the ISOLATED world (which owns chrome.* and does the parsing).
 *
 * Must NOT use any chrome.* APIs — MAIN world has no access to them.
 */
import { createBridge, onFromIsolated, sendToIsolated } from '@src/lib/broadcast-bridge';

// Key the bridge on origin+pathname (not the full href): bilibili rewrites the
// query string via replaceState after load, and the MAIN (document_start) and
// ISOLATED (document_idle) scripts must derive the same channel name. The
// pathname (the BV id) is stable and unique per video.
const bridgeKey = window.location.origin + window.location.pathname;
const channel = createBridge(bridgeKey);

// Matches every known playurl endpoint across bilibili.com and bilibili.tv.
const isPlayurlUrl = (url: string): boolean => {
  if (!url) return false;
  return url.includes('/playurl') || url.includes('playurl?');
};

// Relay the page's metadata store. Sent before every playurl so the ISOLATED
// side has a fresh title/thumbnail even across SPA navigation (bilibili mutates
// __INITIAL_STATE__.videoData in place when you switch videos).
const relayState = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__INITIAL_STATE__) {
    sendToIsolated(channel, { name: 'bili_state', data: { state: w.__INITIAL_STATE__, href: location.href } });
  }
};

const relayPlayurl = (raw: unknown, origin: string) => {
  relayState();
  sendToIsolated(channel, { name: 'bili_playurl', data: { raw, origin, href: location.href } });
};

// SSR globals present on the first document load.
const relayInitial = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  relayState();
  if (w.__playinfo__) relayPlayurl(w.__playinfo__, 'playinfo');
};

// ─── fetch sniffer ───
const originalFetch = window.fetch;
window.fetch = (...args: Parameters<typeof fetch>): Promise<Response> => {
  // Must bind to window — a native fetch called unbound throws "Illegal invocation".
  const promise = originalFetch.apply(window, args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input ?? '');
    if (isPlayurlUrl(url)) {
      promise
        .then(res => res.clone().json())
        .then(json => relayPlayurl(json, 'playurl'))
        .catch(() => undefined);
    }
  } catch {
    /* never break the page's own fetch */
  }
  return promise;
};

// ─── XHR sniffer ───
const originalOpen = XMLHttpRequest.prototype.open;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
XMLHttpRequest.prototype.open = function patchedOpen(this: any, method: string, url: string | URL, ...rest: any[]) {
  this.__biliUrl = typeof url === 'string' ? url : url.toString();
  // eslint-disable-next-line prefer-spread
  return originalOpen.apply(this, [method, url, ...rest] as never);
};

const originalSend = XMLHttpRequest.prototype.send;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
XMLHttpRequest.prototype.send = function patchedSend(this: any, ...sendArgs: any[]) {
  this.addEventListener('load', () => {
    try {
      const url: string = this.__biliUrl ?? '';
      if (!isPlayurlUrl(url)) return;
      const rt = this.responseType;
      if (rt === '' || rt === 'text') {
        relayPlayurl(JSON.parse(this.responseText), 'playurl');
      } else if (rt === 'json' && this.response) {
        relayPlayurl(this.response, 'playurl');
      }
    } catch {
      /* non-JSON or cross-origin — ignore */
    }
  });
  return originalSend.apply(this, sendArgs as never);
};

// Re-send SSR globals on demand (the ISOLATED side asks once it's ready, since
// it loads at document_idle — after this MAIN script's document_start run).
onFromIsolated(channel, msg => {
  if (msg.name === 'bili_request_initial') relayInitial();
});

relayInitial();
