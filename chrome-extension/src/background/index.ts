/// <reference types="vite/client" />
import 'webextension-polyfill';
import { handleNetworkDetection, upsertDetection, clearTabDetections } from './lib/detection';
import { handleDownload, pauseDownload, cancelDownload } from './lib/download';
import { setupHeaderCapture, cleanupStaleDnrRules } from './lib/header-capture';
import { deriveKind, deriveFileName } from './lib/media-utils';
import { updateProgress, clearProgress, clearTerminalProgress } from './lib/progress';
import { MEDIA_MESSAGE } from '@extension/shared';
import type { MediaMessage } from '@extension/shared';

// ─── Offscreen error monitor ───
setInterval(() => {
  chrome.storage.local.get('__offscreen_error__', res => {
    if (res.__offscreen_error__) {
      console.error('FATAL OFFSCREEN ERROR CAUGHT:', res.__offscreen_error__);
    }
  });
}, 1000);

// ─── Header capture & stale DNR cleanup ───
setupHeaderCapture();
cleanupStaleDnrRules();

// ─── Network detection listener ───
chrome.webRequest.onResponseStarted.addListener(
  details => {
    void handleNetworkDetection(details);
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders', 'extraHeaders'],
);

// ─── Message listener ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  (async () => {
    if (message.type === 'offscreen/progress') {
      await updateProgress(message.payload.key, message.payload.prog);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'offscreen/clear') {
      await clearProgress(message.payload.key);
      sendResponse({ ok: true });
      return;
    }
    const msg = message as MediaMessage;
    if (msg.type === MEDIA_MESSAGE.DETECTED) {
      await upsertDetection(msg.payload, sender.tab?.id, sender.tab?.url);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === MEDIA_MESSAGE.DOWNLOAD) {
      const result = await handleDownload(msg.payload);
      sendResponse(result);
      return;
    }
    if (msg.type === MEDIA_MESSAGE.CANCEL) {
      if (msg.payload.intent === 'pause') {
        pauseDownload(msg.payload.url);
      } else {
        cancelDownload(msg.payload.url);
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === MEDIA_MESSAGE.CLEAR_TAB) {
      const tabId = msg.payload?.tabId ?? sender.tab?.id;
      if (tabId !== undefined) await clearTabDetections(tabId);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === MEDIA_MESSAGE.CLEAR_DOWNLOADS) {
      await clearTerminalProgress(msg.payload?.keys);
      sendResponse({ ok: true });
      return;
    }
    // Play / Show in folder for completed downloads
    if (message.type === 'media/open' && typeof message.downloadId === 'number') {
      chrome.downloads.open(message.downloadId);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'media/show' && typeof message.downloadId === 'number') {
      chrome.downloads.show(message.downloadId);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'media/get-tab-id') {
      // Content scripts cannot call chrome.tabs.getCurrent() — they must ask the background
      sendResponse({ tabId: sender.tab?.id ?? null });
      return;
    }
    if (message.type === 'media/force-detect' && typeof message.tabId === 'number') {
      // Execute a scan script on the target tab to find any missed media URLs
      try {
        await chrome.scripting.executeScript({
          target: { tabId: message.tabId },
          func: () => {
            /** Decode HTML entities using browser's parser */
            const decode = (s: string) => {
              try {
                const t = document.createElement('textarea');
                t.innerHTML = s;
                return t.value;
              } catch {
                return s;
              }
            };
            const pageTitle = decode(
              document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ||
                document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.content ||
                document.title ||
                '',
            );

            const found = new Set<string>();

            // 1. All video/audio element sources (non-blob)
            document.querySelectorAll<HTMLMediaElement>('video, audio').forEach(el => {
              [el.currentSrc, el.src].forEach(u => {
                if (u && !u.startsWith('blob:') && u.startsWith('http')) found.add(u);
              });
              el.querySelectorAll<HTMLSourceElement>('source').forEach(s => {
                if (s.src && !s.src.startsWith('blob:')) found.add(s.src);
              });
            });

            // 2. HLS.js instances attached to video elements
            document.querySelectorAll<HTMLVideoElement>('video').forEach(v => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const hls = (v as any)._hls || (v as any).__hls__ || (v as any).hls;
              if (hls?.url && typeof hls.url === 'string') found.add(hls.url);
            });

            // 3. Global player APIs
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const w = window as any;

              if (w.Hls?.instances)
                Object.values(w.Hls.instances).forEach((h: unknown) => {
                  if ((h as { url?: string })?.url) found.add((h as { url: string }).url);
                });
              if (w.jwplayer) {
                try {
                  const item = w.jwplayer().getPlaylistItem();
                  if (item?.file) found.add(item.file);
                } catch {
                  // jwplayer() might throw if instance not fully initialized
                }
              }
              if (w.videojs) {
                try {
                  Object.values(w.videojs.players || {}).forEach((p: unknown) => {
                    const s = (p as { currentSrc?: () => string })?.currentSrc?.();
                    if (s && !s.startsWith('blob:')) found.add(s);
                  });
                } catch {
                  // videojs access might fail if not ready
                }
              }
            } catch {
              // Global player detection can fail on some pages - ignore
            }

            // Send each found URL as a detection
            found.forEach(url => {
              chrome.runtime
                .sendMessage({
                  type: 'media/detected',
                  payload: { url, source: 'element', title: pageTitle },
                })
                .catch(() => {});
            });

            return found.size;
          },
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }
    sendResponse({ ok: false, error: 'Unknown message type' });
  })().catch(error => {
    console.error('onMessage handler failed', error);
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

// ─── Tab listeners ───
chrome.tabs.onRemoved.addListener(tabId => {
  void clearTabDetections(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') void clearTabDetections(tabId);
});

// ─── Context menu ───
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'download-media',
    title: 'Download media',
    contexts: ['video', 'audio'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'download-media') return;
  const srcUrl = info.srcUrl;
  if (!srcUrl) return;
  const kind = deriveKind(srcUrl);
  if (kind === 'video' || kind === 'audio') {
    void handleDownload({
      url: srcUrl,
      kind,
      fileName: deriveFileName(srcUrl, tab?.title),
      title: tab?.title,
      tabId: tab?.id,
    });
  } else {
    void upsertDetection({ url: srcUrl, kind, source: 'element' }, tab?.id, tab?.url);
  }
});

console.log('Background loaded with media detection');
