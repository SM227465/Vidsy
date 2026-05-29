// Download interceptor — catches browser-initiated downloads and offers to
// route them through Vidsy via a modal in the originating tab.
//
// When the setting `enableDownloadInterceptor` is on, listens for browser-
// initiated video/audio downloads via chrome.downloads.onCreated, cancels +
// erases them, and asks the content-ui in a content-script-capable tab to
// show a modal offering the choice between Vidsy and browser native handling.
//
// Many downloads spawn a transient about:blank tab and arrive with empty
// `referrer` / `filename` fields — the tab lookup falls through several
// strategies before giving up, and the MIME filter checks the URL path
// extension when both the MIME and filename are unhelpful.
//
// Vidsy's own downloads (offscreen doc → chrome.downloads.download against
// a blob: URL) and re-issued browser downloads bypass this listener via
// URL prefix matching and a short-lived "recently resumed" allowlist.

import { MEDIA_MESSAGE } from '@extension/shared';
import { mediaSettingsStorage } from '@extension/storage';

const MEDIA_EXTENSIONS = new Set([
  'mp4',
  'mkv',
  'webm',
  'mov',
  'avi',
  'flv',
  'wmv',
  'mpg',
  'mpeg',
  'm4v',
  'ts',
  'mp3',
  'm4a',
  'aac',
  'flac',
  'wav',
  'opus',
  'ogg',
  'oga',
]);

// URLs we re-issued ourselves (after the user picked "Open in browser") get
// a 5-second pass so the resulting onCreated doesn't trigger another modal.
const recentlyResumed = new Map<string, number>();
const RESUME_WINDOW_MS = 5_000;

// In-memory cache of the setting; invalidated by chrome.storage.onChanged
// so we don't rely on subscribe callbacks firing in the SW context.
let cachedEnabled: boolean | null = null;

const readEnabled = async (): Promise<boolean> => {
  if (cachedEnabled !== null) return cachedEnabled;
  const s = await mediaSettingsStorage.get();
  cachedEnabled = !!s.enableDownloadInterceptor;
  return cachedEnabled;
};

const markResumed = (url: string): void => {
  recentlyResumed.set(url, Date.now());
};

const shouldBypass = (url: string): boolean => {
  const ts = recentlyResumed.get(url);
  if (!ts) return false;
  if (Date.now() - ts > RESUME_WINDOW_MS) {
    recentlyResumed.delete(url);
    return false;
  }
  return true;
};

const extensionOf = (s: string | undefined): string => {
  if (!s) return '';
  const m = s.toLowerCase().match(/\.([a-z0-9]+)(?:$|[?#])/);
  return m ? m[1] : '';
};

const urlPathExtension = (url: string | undefined): string => {
  if (!url) return '';
  try {
    return extensionOf(new URL(url).pathname);
  } catch {
    return '';
  }
};

const isMediaDownload = (item: chrome.downloads.DownloadItem): boolean => {
  const mime = (item.mime ?? '').toLowerCase();
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return true;
  // Servers commonly return application/octet-stream for large media files —
  // check filename first, then fall back to the URL path (CDN URLs often
  // preserve the extension even when filename is blank).
  if (mime === 'application/octet-stream' || mime === '') {
    const ext = extensionOf(item.filename) || urlPathExtension(item.finalUrl || item.url);
    return MEDIA_EXTENSIONS.has(ext);
  }
  return false;
};

const isExtensionOriginUrl = (url: string): boolean => {
  if (!url) return true;
  if (url.startsWith('blob:chrome-extension:')) return true;
  if (url.startsWith('chrome-extension:')) return true;
  if (url.startsWith('data:')) return true;
  return false;
};

const originOf = (url: string | undefined): string => {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

const isContentScriptCapable = (url: string | undefined): boolean => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

// Find a tab to host the intercept modal. The download itself often arrives
// from a fresh about:blank tab with no content script — fall through several
// strategies before giving up.
const findHostTab = async (referrer: string | undefined): Promise<chrome.tabs.Tab | undefined> => {
  // 1. Tab whose origin matches the download referrer.
  const refOrigin = originOf(referrer);
  if (refOrigin) {
    const all = await chrome.tabs.query({});
    const matches = all.filter(t => isContentScriptCapable(t.url) && originOf(t.url) === refOrigin);
    if (matches.length > 0) {
      const active = matches.find(t => t.active);
      return active ?? matches[0];
    }
  }

  // 2. Active tab in the last-focused window, if it has a content script.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isContentScriptCapable(active.url)) return active;

  // 3. Any other tab in the same window (the user's most-likely context).
  if (active?.windowId !== undefined) {
    const windowTabs = await chrome.tabs.query({ windowId: active.windowId });
    const cap = windowTabs.find(t => isContentScriptCapable(t.url));
    if (cap) return cap;
  }

  // 4. Any tab in any window — last resort.
  const all = await chrome.tabs.query({});
  return all.find(t => isContentScriptCapable(t.url));
};

const sendInterceptToTab = async (
  tab: chrome.tabs.Tab | undefined,
  item: chrome.downloads.DownloadItem,
): Promise<void> => {
  if (!tab?.id) {
    console.log('[Vidsy] no host tab available — modal cannot show');
    return;
  }
  console.log('[Vidsy] sending intercept modal to tab:', { id: tab.id, url: tab.url });
  try {
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        /* window may not exist anymore */
      }
    }
  } catch {
    /* ignore focus errors */
  }
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: MEDIA_MESSAGE.INTERCEPT_SHOW,
      payload: {
        url: item.finalUrl || item.url,
        fileName:
          (item.filename ? item.filename.split('/').pop() : undefined) ||
          decodeURIComponent(new URL(item.finalUrl || item.url).pathname.split('/').pop() || ''),
        mime: item.mime || undefined,
        fileSize: item.fileSize > 0 ? item.fileSize : item.totalBytes > 0 ? item.totalBytes : undefined,
        referrer: item.referrer || undefined,
      },
    });
  } catch (err) {
    console.log('[Vidsy] sendMessage failed:', err);
  }
};

// Synchronous handler — cancels BEFORE any await so Chrome's save-as dialog
// doesn't get a chance to render. The async tail (find tab + send modal)
// runs after the cancel is in flight.
const handleCreated = (item: chrome.downloads.DownloadItem): void => {
  console.log('[Vidsy] downloads.onCreated:', {
    id: item.id,
    state: item.state,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    filename: item.filename,
    fileSize: item.fileSize,
    totalBytes: item.totalBytes,
    referrer: item.referrer,
  });

  if (item.state !== 'in_progress') {
    console.log('[Vidsy] skip: state is', item.state);
    return;
  }

  const url = item.finalUrl || item.url;
  if (isExtensionOriginUrl(url)) {
    console.log('[Vidsy] skip: extension-origin url');
    return;
  }
  if (shouldBypass(url)) {
    console.log('[Vidsy] skip: recently resumed (5s bypass)');
    return;
  }

  // Sync setting gate. If the cache is uninitialized (SW just woke up), skip
  // this download and kick off the async load so the next one is handled.
  if (cachedEnabled === false) {
    console.log('[Vidsy] skip: interceptor disabled');
    return;
  }
  if (cachedEnabled === null) {
    console.log('[Vidsy] skip: setting cache not yet populated; loading for next time');
    void readEnabled();
    return;
  }

  if (!isMediaDownload(item)) {
    console.log('[Vidsy] skip: not a media download (mime/ext mismatch)');
    return;
  }

  console.log('[Vidsy] intercepting:', { url, mime: item.mime, fileSize: item.fileSize, referrer: item.referrer });

  // Cancel SYNCHRONOUSLY (no awaits before this point) so the save-as dialog
  // never gets shown. The API calls are async but we don't await them here.
  chrome.downloads.cancel(item.id).catch(() => undefined);
  chrome.downloads.erase({ id: item.id }).catch(() => undefined);

  // Async tail: find a tab with content-ui and send the modal.
  void (async () => {
    const tab = await findHostTab(item.referrer);
    await sendInterceptToTab(tab, item);
  })();
};

const setupDownloadInterceptor = (): void => {
  // Seed the cache eagerly so the first download after SW wake-up has a
  // chance of being intercepted (resolves within a few ms on a warm profile).
  void readEnabled();

  // Invalidate on any settings change — chrome.storage.onChanged is more
  // reliable in SW contexts than the storage wrapper's subscribe API.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['media-settings']) {
      cachedEnabled = null;
      void readEnabled();
    }
  });

  chrome.downloads.onCreated.addListener(handleCreated);
};

// Re-issue a download in the browser after the user picks "Open in browser".
// Marks the URL so the onCreated listener lets it through.
const resumeBrowserDownload = (url: string, fileName?: string): void => {
  markResumed(url);
  void chrome.downloads.download(fileName ? { url, filename: fileName } : { url });
};

// Standalone progress window — opens the popup HTML in a chrome popup
// window (no tabs, no address bar) deep-linked to the download details view.
// The window survives main-browser minimize so the user can keep watching
// progress while doing other things.
let downloadsWindowId: number | null = null;

const openDownloadsWindow = async (): Promise<void> => {
  if (downloadsWindowId !== null) {
    try {
      await chrome.windows.update(downloadsWindowId, { focused: true });
      return;
    } catch {
      downloadsWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup/index.html#download-details'),
    type: 'popup',
    width: 480,
    height: 520,
    focused: true,
  });
  downloadsWindowId = win?.id ?? null;
};

chrome.windows.onRemoved.addListener(id => {
  if (id === downloadsWindowId) downloadsWindowId = null;
});

export { setupDownloadInterceptor, resumeBrowserDownload, openDownloadsWindow };
