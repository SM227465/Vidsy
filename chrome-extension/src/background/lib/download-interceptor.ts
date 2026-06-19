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

const LARGE_OPAQUE_THRESHOLD = 50 * 1024 * 1024; // 50 MB

const isMediaDownload = (item: chrome.downloads.DownloadItem): boolean => {
  const mime = (item.mime ?? '').toLowerCase();
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return true;
  // Servers commonly return application/octet-stream for large media files —
  // check filename first, then fall back to the URL path (CDN URLs often
  // preserve the extension even when filename is blank).
  if (mime === 'application/octet-stream' || mime === '') {
    const ext = extensionOf(item.filename) || urlPathExtension(item.finalUrl || item.url);
    if (MEDIA_EXTENSIONS.has(ext)) return true;
    // Last resort: some file hosts hide the real filename behind an opaque
    // token URL (e.g. https://host/<hash>?token=...) and serve it as
    // application/octet-stream with an empty Content-Disposition filename.
    // For those we use byte-size as a heuristic — large opaque downloads
    // are overwhelmingly media. The modal still lets the user pick
    // 'Open in Browser' if we guessed wrong on a big installer/ISO.
    const size = item.fileSize > 0 ? item.fileSize : item.totalBytes;
    if (size && size >= LARGE_OPAQUE_THRESHOLD) return true;
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
  // The original download was already cancelled AND erased — if the modal
  // can't be shown (no content-script-capable tab, or the message fails),
  // we must re-issue the browser download or the user's click is silently
  // swallowed with no way to recover it.
  const fallbackToBrowser = () => {
    resumeBrowserDownload(item.finalUrl || item.url, item.filename ? item.filename.split('/').pop() : undefined);
  };
  if (!tab?.id) {
    console.log('[Vidsy] no host tab available — re-issuing browser download');
    fallbackToBrowser();
    return;
  }
  const tabId = tab.id;
  console.log('[Vidsy] sending intercept modal to tab:', { id: tabId, url: tab.url });
  try {
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
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

  const payload = {
    url: item.finalUrl || item.url,
    fileName:
      (item.filename ? item.filename.split('/').pop() : undefined) ||
      decodeURIComponent(new URL(item.finalUrl || item.url).pathname.split('/').pop() || ''),
    mime: item.mime || undefined,
    fileSize: item.fileSize > 0 ? item.fileSize : item.totalBytes > 0 ? item.totalBytes : undefined,
    referrer: item.referrer || undefined,
  };
  const trySend = async (): Promise<boolean> => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: MEDIA_MESSAGE.INTERCEPT_SHOW, payload });
      return true;
    } catch {
      return false;
    }
  };

  if (await trySend()) return;

  // The tab has no content script listening — almost always because it was open
  // before the extension loaded/updated (content scripts only inject on
  // navigation). Inject the content-ui on demand and retry once before unwinding.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-ui/all.iife.js'] });
    // Give React time to mount and register the onMessage listener.
    await new Promise(r => setTimeout(r, 400));
    if (await trySend()) {
      console.log('[Vidsy] modal shown after on-demand injection');
      return;
    }
  } catch (err) {
    console.log('[Vidsy] on-demand content-script injection failed:', err);
  }

  console.log('[Vidsy] modal could not be shown — re-issuing browser download');
  fallbackToBrowser();
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

  // Setting is definitively OFF — skip.
  if (cachedEnabled === false) {
    console.log('[Vidsy] skip: interceptor disabled');
    return;
  }

  if (!isMediaDownload(item)) {
    console.log('[Vidsy] skip: not a media download (mime/ext mismatch)');
    return;
  }

  console.log('[Vidsy] intercepting:', {
    url,
    mime: item.mime,
    fileSize: item.fileSize,
    referrer: item.referrer,
    cachedEnabled,
  });

  // Optimistic cancel — fires synchronously regardless of whether the cache
  // has finished loading yet. Without this, a download arriving immediately
  // after SW wake-up would slip through with the native save-as dialog. If
  // the cache resolves to disabled afterward (rare — setting is ON by
  // default), we re-issue the browser download below.
  chrome.downloads.cancel(item.id).catch(() => undefined);
  chrome.downloads.erase({ id: item.id }).catch(() => undefined);

  void (async () => {
    // Wait for the cache if it hadn't loaded yet at the sync gate above,
    // then decide whether to show the modal or unwind by re-issuing.
    if (cachedEnabled === null) {
      const enabled = await readEnabled();
      if (!enabled) {
        console.log('[Vidsy] cache loaded as disabled — resuming browser download');
        resumeBrowserDownload(url, item.filename ? item.filename.split('/').pop() : undefined);
        return;
      }
    }
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

// Standalone progress window — one window per download (keyed by the
// download URL/key). Opens the popup HTML deep-linked to the download
// details view with the key on the query string so each window pins to a
// single download instead of showing whichever job is most recent. The
// window survives main-browser minimize so the user can keep watching
// progress while doing other things.
const downloadWindowIds = new Map<string, number>();

const openDownloadsWindow = async (key: string): Promise<void> => {
  // If a window for this exact download is already open, focus it instead
  // of spawning a duplicate.
  const existingId = downloadWindowIds.get(key);
  if (existingId !== undefined) {
    try {
      await chrome.windows.update(existingId, { focused: true });
      return;
    } catch {
      downloadWindowIds.delete(key);
    }
  }
  const url = `popup/index.html?dlKey=${encodeURIComponent(key)}#download-details`;
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(url),
    type: 'popup',
    width: 480,
    height: 460,
    focused: true,
  });
  if (win?.id !== undefined) downloadWindowIds.set(key, win.id);
};

chrome.windows.onRemoved.addListener(closedId => {
  for (const [key, winId] of downloadWindowIds) {
    if (winId === closedId) {
      downloadWindowIds.delete(key);
      break;
    }
  }
});

export { setupDownloadInterceptor, resumeBrowserDownload, openDownloadsWindow };
