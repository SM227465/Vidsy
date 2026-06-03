/// <reference types="vite/client" />
import 'webextension-polyfill';
import { handleNetworkDetection, upsertDetection, clearTabDetections, setMainVideoPresent } from './lib/detection';
import { handleDownload, pauseDownload, cancelDownload } from './lib/download';
import { setupDownloadInterceptor, resumeBrowserDownload, openDownloadsWindow } from './lib/download-interceptor';
import { reorderQueueItem } from './lib/download-queue';
import { setupHeaderCapture, cleanupStaleDnrRules } from './lib/header-capture';
import { deriveKind, deriveFileName } from './lib/media-utils';
import { classifyAndAddUrl } from './lib/paste-url';
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

// ─── Browser download interceptor (opt-in via settings) ───
setupDownloadInterceptor();

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
    if (msg.type === MEDIA_MESSAGE.QUEUE_REORDER) {
      const ok = await reorderQueueItem(msg.payload.key, msg.payload.direction);
      sendResponse({ ok });
      return;
    }
    if (msg.type === MEDIA_MESSAGE.INTERCEPT_DOWNLOAD_VIDSY) {
      const tabId = sender.tab?.id;
      const kind = deriveKind(msg.payload.url);
      // Open the per-download progress window BEFORE kicking off the
      // download — keyed on the URL so each download gets its own window
      // (handleDownload uses url as the storage key by default).
      void openDownloadsWindow(msg.payload.url);
      const result = await handleDownload({
        url: msg.payload.url,
        fileName: msg.payload.fileName ?? deriveFileName(msg.payload.url),
        title: msg.payload.fileName,
        tabId,
        kind,
      });
      sendResponse(result);
      return;
    }
    if (msg.type === MEDIA_MESSAGE.INTERCEPT_RESUME_BROWSER) {
      resumeBrowserDownload(msg.payload.url, msg.payload.fileName);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === MEDIA_MESSAGE.INTERCEPT_DISMISS) {
      // Original download is already cancelled — nothing to do beyond ack.
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === MEDIA_MESSAGE.MAIN_VIDEO_PRESENT) {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) setMainVideoPresent(tabId, msg.payload.present);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === MEDIA_MESSAGE.PASTE_URL) {
      const tabId = msg.payload.tabId ?? sender.tab?.id;
      let pageUrl: string | undefined = sender.tab?.url;
      if (tabId !== undefined && !pageUrl) {
        try {
          const tab = await chrome.tabs.get(tabId);
          pageUrl = tab.url;
        } catch {
          // Tab may be gone — proceed without pageUrl
        }
      }
      const result = await classifyAndAddUrl(msg.payload.url, tabId, pageUrl);
      sendResponse(result);
      return;
    }
    if (msg.type === MEDIA_MESSAGE.PICKER_START) {
      const tabId = msg.payload?.tabId ?? sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ ok: false, error: 'No active tab' });
        return;
      }
      try {
        await chrome.tabs.sendMessage(tabId, { type: MEDIA_MESSAGE.PICKER_ACTIVATE });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (msg.type === MEDIA_MESSAGE.PICKER_PICKED) {
      const tabId = sender.tab?.id;
      const pageUrl = sender.tab?.url;
      const result = await classifyAndAddUrl(msg.payload.url, tabId, pageUrl);
      sendResponse(result);
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
// Host suffixes where context-menu actions must no-op. chrome.contextMenus
// pattern lists are positive-only so we can't exclude via the API; the
// click handler below short-circuits when the page or target URL matches.
const isRestrictedMenuUrl = (url: string | undefined): boolean => {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'youtube.com' || host === 'youtu.be') return true;
    return host.endsWith('.youtube.com') || host.endsWith('.youtube-nocookie.com') || host.endsWith('.googlevideo.com');
  } catch {
    return false;
  }
};

const createContextMenus = () => {
  // Idempotent — re-creating on service-worker restart throws "duplicate id".
  try {
    chrome.contextMenus.create({
      id: 'download-media',
      title: 'Download media',
      contexts: ['video', 'audio'],
    });
  } catch {
    // Already registered
  }
  try {
    chrome.contextMenus.create({
      id: 'send-link-to-vidsy',
      title: 'Send link to Vidsy',
      contexts: ['link'],
    });
  } catch {
    // Already registered
  }
};

chrome.runtime.onInstalled.addListener(createContextMenus);
chrome.runtime.onStartup.addListener(createContextMenus);

// ─── Hotkey: Alt+Shift+V activates the element picker on the active tab ───
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'activate-picker') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MEDIA_MESSAGE.PICKER_ACTIVATE });
  } catch {
    // Tab may not have a content script (chrome://, web store, etc.)
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // No-op the context menu when the page itself or the targeted URL is on
  // a restricted host. Manifest exclude_matches prevents content scripts
  // from injecting there in the first place, but the context menu lives
  // in the browser chrome and surfaces independently of our injection.
  if (
    isRestrictedMenuUrl(tab?.url) ||
    isRestrictedMenuUrl(info.pageUrl) ||
    isRestrictedMenuUrl(info.srcUrl) ||
    isRestrictedMenuUrl(info.linkUrl)
  ) {
    return;
  }
  if (info.menuItemId === 'download-media') {
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
    return;
  }
  if (info.menuItemId === 'send-link-to-vidsy') {
    const linkUrl = info.linkUrl;
    if (!linkUrl) return;
    void (async () => {
      const result = await classifyAndAddUrl(linkUrl, tab?.id, tab?.url);
      if (result.ok) {
        // Item is now in the per-tab detected list and the badge counter has
        // bumped automatically (see upsertDetection -> updateBadge). Try to
        // open the popup so the user lands on the result immediately.
        try {
          await chrome.action.openPopup();
        } catch {
          // openPopup() requires a recent user gesture in some Chrome
          // versions. The badge already signals the new item — user can
          // click the icon to open.
        }
      } else {
        console.warn('[Vidsy] Send link to Vidsy:', result.error);
      }
    })();
  }
});

console.log('Background loaded with media detection');
