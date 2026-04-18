import { MEDIA_MESSAGE, useStorage } from '@extension/shared';
import { mediaDetectionsStorage, mediaDownloadsStorage, mediaSettingsStorage } from '@extension/storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaDownloadProgress, MediaItem } from '@extension/shared';
import { VideoEntry, ACTIVE_STAGES, pickBestVariant, qLabel, kindStr, buildRows } from './lib/media-helpers';
import { FONT } from './components/tokens';
import { PillBar } from './components/PillBar';
import { DropdownPanel } from './components/DropdownPanel';

const App = () => {
  const detections = useStorage(mediaDetectionsStorage);
  const rawDownloads = useStorage(mediaDownloadsStorage);
  const downloads = useMemo(() => (rawDownloads ?? {}) as Record<string, MediaDownloadProgress>, [rawDownloads]);
  const settings = useStorage(mediaSettingsStorage);

  /* tab ID via background message (chrome.tabs not available in content scripts) */
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'media/get-tab-id' })
      .then((r: { tabId: number | null }) => {
        if (r?.tabId != null) setTabId(r.tabId);
      })
      .catch(() => {});
  }, []);

  const tabItems = useMemo<MediaItem[]>(() => {
    if (!detections || tabId === null) return [];
    return detections[String(tabId)] ?? [];
  }, [detections, tabId]);

  /* video element tracking */
  const [videos, setVideos] = useState<VideoEntry[]>([]);
  useEffect(() => {
    let n = 0;
    const ids = new WeakMap<HTMLVideoElement, string>();
    const getId = (el: HTMLVideoElement) => {
      if (!ids.has(el)) ids.set(el, `v${n++}`);
      return ids.get(el)!;
    };
    let rAF: number | null = null;
    const measure = () => {
      if (rAF !== null) return;
      rAF = requestAnimationFrame(() => {
        rAF = null;
        setVideos(
          Array.from(document.querySelectorAll<HTMLVideoElement>('video'))
            .filter(el => el.offsetWidth > 100 && el.offsetHeight > 60)
            .map(el => ({ el, id: getId(el), rect: el.getBoundingClientRect() })),
        );
      });
    };
    const mo = new MutationObserver(measure);
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'style', 'class'],
    });
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    measure();
    const t = setInterval(measure, 800);
    return () => {
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      clearInterval(t);
    };
  }, []);

  /* UI state */
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busyUrl, setBusyUrl] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const prevVideoRef = useRef<VideoEntry | undefined>(undefined);

  /* Outside-click closes dropdown
     IMPORTANT: The content-ui runs inside a shadow DOM. At document level,
     event.target is retargeted to the shadow host, so ref.current.contains()
     always returns false for clicks INSIDE our component, causing the handler
     to close the dropdown on every internal click (including dropdown rows).
     Fix: use e.composedPath() which correctly includes shadow DOM internals. */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const path = e.composedPath();
      if (ref.current && !path.includes(ref.current as unknown as EventTarget)) setOpen(false);
    };
    const tid = setTimeout(() => document.addEventListener('mousedown', handler, true), 0);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('mousedown', handler, true);
    };
  }, [open]);

  /* download helpers */
  const doDownload = useCallback(
    async (item: MediaItem, variantUrl?: string) => {
      const url = variantUrl ?? item.url;
      setBusyUrl(item.url);
      setOpen(false);
      const fmt = item.kind === 'audio' ? 'mp3' : 'mp4';
      await chrome.runtime.sendMessage({
        type: MEDIA_MESSAGE.DOWNLOAD,
        payload: {
          url,
          key: item.url,
          kind: item.kind,
          fileName: item.fileName,
          title: item.title,
          tabId: tabId ?? undefined,
          outputFormat: settings?.enableHlsMerging ? fmt : undefined,
        },
      });
      // Keep busyUrl until storage reports success/fail
    },
    [settings, tabId],
  );

  const doCancel = useCallback(async (url: string) => {
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CANCEL, payload: { url } });
    setBusyUrl(null);
  }, []);

  /* clear busyUrl once storage reports terminal stage */
  useEffect(() => {
    if (!busyUrl) return undefined;
    const prog = downloads[busyUrl];
    if (prog?.stage === 'success' || prog?.stage === 'failed') {
      const t = setTimeout(() => setBusyUrl(null), 2000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [downloads, busyUrl]);

  /* Recover active download after page refresh */
  useEffect(() => {
    if (busyUrl) return; // already tracking something
    const activeEntry = Object.entries(downloads).find(([, p]) => ACTIVE_STAGES.has(p.stage));
    if (activeEntry) setBusyUrl(activeEntry[0]);
    // Only run on first mount (when downloads first becomes available)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloads]);

  if (tabItems.length === 0 || dismissed) return null;

  /* active progress */
  const primary = tabItems[0];
  const activeItem = busyUrl
    ? tabItems.find(it => it.url === busyUrl)
    : tabItems.find(it => {
        const p = downloads[it.url];
        return p != null && ACTIVE_STAGES.has(p.stage);
      });
  const isBusy = !!activeItem;

  /* positioning */
  const MIN_W = 280,
    MIN_H = 160;
  const mainVideo = videos
    .filter(v => v.rect.width >= MIN_W && v.rect.height >= MIN_H)
    .reduce<VideoEntry | undefined>(
      (b, c) => (!b ? c : c.rect.width * c.rect.height > b.rect.width * b.rect.height ? c : b),
      undefined,
    );

  /* Hysteresis */
  let effectiveVideo = mainVideo;
  if (!mainVideo && (open || isHovered || isBusy)) {
    effectiveVideo = prevVideoRef.current;
  }
  if (effectiveVideo) {
    prevVideoRef.current = effectiveVideo;
  }

  if (!effectiveVideo) return null;

  const vr = effectiveVideo.rect;
  const right = vr ? window.innerWidth - vr.right + 8 : 12;
  const top = vr ? vr.top + 8 : 12;

  const prog = activeItem ? (downloads[activeItem.url] ?? null) : null;

  /* percentage calc */
  const pct =
    prog?.stage === 'mux' && prog.muxPercent !== undefined
      ? prog.muxPercent
      : prog?.estimatedBytes
        ? Math.min(100, Math.round((prog.downloadedBytes / prog.estimatedBytes) * 100))
        : null;

  const stageShort: Record<string, string> = {
    init: 'Downloading…',
    'fetch-manifest': 'Downloading…',
    'download-video': 'Downloading…',
    'download-audio': 'Downloading…',
    mux: 'Downloading…',
    finalize: 'Downloading…',
    success: '✓ Done',
    failed: '✗ Failed',
  };

  const rows = buildRows(tabItems);
  const bestVariant = primary.variants?.length ? pickBestVariant(primary.variants) : undefined;
  const bestUrl = bestVariant?.url ?? primary.variants?.[0]?.url ?? primary.url;
  const bestQLabel = bestVariant ? qLabel(bestVariant) : '';

  return (
    <div
      ref={ref}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{ position: 'fixed', top, right, zIndex: 2147483647, pointerEvents: 'auto', fontFamily: FONT }}>
      <PillBar
        primary={primary}
        isBusy={isBusy}
        prog={prog}
        pct={pct}
        bestUrl={bestUrl}
        bestQLabel={bestQLabel}
        open={open}
        stageShort={stageShort}
        onMainClick={() => {
          if (isBusy) {
            if (activeItem) doCancel(activeItem.url);
          } else {
            doDownload(primary, bestUrl);
          }
        }}
        onToggleOpen={() => setOpen(o => !o)}
        onDismiss={() => setDismissed(true)}
      />

      {open && !isBusy && (
        <DropdownPanel
          rows={rows}
          primary={primary}
          bestUrl={bestUrl}
          bestQLabel={bestQLabel}
          onDownload={doDownload}
        />
      )}
    </div>
  );
};

export default App;
