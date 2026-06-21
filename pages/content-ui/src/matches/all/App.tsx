import { DropdownPanel } from './components/DropdownPanel';
import { InterceptModal } from './components/InterceptModal';
import { PillBar } from './components/PillBar';
import { FONT } from './components/tokens';
import { ACTIVE_STAGES, pickBestVariant, qLabel, buildRows } from './lib/media-helpers';
import { MEDIA_MESSAGE, useStorage } from '@extension/shared';
import { mediaDetectionsStorage, mediaDownloadsStorage, mediaSettingsStorage } from '@extension/storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VideoEntry } from './lib/media-helpers';
import type { MediaDownloadProgress, MediaItem } from '@extension/shared';

// Collect <video> elements, piercing open shadow roots. Some players (VK) mount
// their <video> inside a web component, where document.querySelectorAll('video')
// can't reach it. Light DOM is the fast path; only walk shadow roots when the
// light DOM has none, to keep ordinary pages cheap.
const collectVideos = (): HTMLVideoElement[] => {
  const light = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
  if (light.length > 0) return light;
  const out: HTMLVideoElement[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) {
        out.push(...Array.from(el.shadowRoot.querySelectorAll<HTMLVideoElement>('video')));
        walk(el.shadowRoot);
      }
    }
  };
  walk(document);
  return out;
};

const App = () => {
  const detections = useStorage(mediaDetectionsStorage);
  const rawDownloads = useStorage(mediaDownloadsStorage);
  // Content scripts receive chrome.storage.session onChanged unreliably, so the
  // useStorage value can freeze mid-download (the side panel, an extension page,
  // updates fine). `polled` is refreshed by a direct session read while a job is
  // active (see effect below) and takes precedence so the pill stays live.
  const [polled, setPolled] = useState<Record<string, MediaDownloadProgress> | null>(null);
  // Neither source is authoritative on its own: `rawDownloads` (onChanged) can
  // freeze, and `polled` lags by its interval — which is very visible now that
  // range-parallel downloads finish in seconds (the pill showed a stale % while
  // the live side panel was far ahead). Merge per key, preferring whichever
  // snapshot was written most recently (updatedAt).
  const downloads = useMemo(() => {
    const a = (polled ?? {}) as Record<string, MediaDownloadProgress>;
    const b = (rawDownloads ?? {}) as Record<string, MediaDownloadProgress>;
    const out: Record<string, MediaDownloadProgress> = { ...b, ...a };
    for (const k of Object.keys(out)) {
      const pa = a[k];
      const pb = b[k];
      if (pa && pb) out[k] = (pb.updatedAt ?? 0) > (pa.updatedAt ?? 0) ? pb : pa;
    }
    return out;
  }, [polled, rawDownloads]);
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
          collectVideos()
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
  const [intercept, setIntercept] = useState<{
    url: string;
    fileName?: string;
    mime?: string;
    fileSize?: number;
    referrer?: string;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const prevVideoRef = useRef<VideoEntry | undefined>(undefined);

  /* Download intercept: background cancels a media download and asks us to
     show a modal so the user can route it through Vidsy or open in browser. */
  useEffect(() => {
    const handler = (message: { type?: string; payload?: unknown }) => {
      if (message?.type === MEDIA_MESSAGE.INTERCEPT_SHOW) {
        setIntercept(message.payload as typeof intercept);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

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
      // MSE-fed players have no fetchable source — the badge still shows so the
      // user knows we saw the video, but the action is a no-op.
      if (item.kind === 'mse') return;
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

  /* live recording */
  const doRecord = useCallback(
    async (item: MediaItem) => {
      setBusyUrl(item.url);
      setOpen(false);
      await chrome.runtime.sendMessage({
        type: MEDIA_MESSAGE.RECORD_START,
        payload: {
          url: item.url,
          key: item.url,
          kind: item.kind,
          fileName: item.fileName,
          title: item.title,
          tabId: tabId ?? undefined,
          outputFormat: 'mp4',
          item,
        },
      });
      // Keep busyUrl until storage reports a terminal stage.
    },
    [tabId],
  );

  const doStopRecord = useCallback(async (key: string) => {
    // Finalize: the background muxes the accumulator and saves the MP4.
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.RECORD_STOP, payload: { key } });
  }, []);

  const doDiscardRecord = useCallback(async (key: string) => {
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.RECORD_STOP, payload: { key, discard: true } });
    setBusyUrl(null);
  }, []);

  const doPauseResume = useCallback(async (key: string, paused: boolean) => {
    await chrome.runtime.sendMessage({
      type: paused ? MEDIA_MESSAGE.RECORD_RESUME : MEDIA_MESSAGE.RECORD_PAUSE,
      payload: { key },
    });
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

  /* Elapsed recording time. Accumulate via a 1s tick that runs ONLY while a
     recording is in the 'recording' stage, so Pause freezes the timer. Deriving
     it from wall-clock (now - startedAt) would keep advancing through a pause.
     The accumulator resets when the active recording key changes. */
  const recEntry = Object.entries(downloads).find(([, p]) => p.stage === 'recording' || p.stage === 'recording-paused');
  const recKey = recEntry?.[0] ?? null;
  const isActivelyRecording = recEntry?.[1]?.stage === 'recording';
  const elapsedRef = useRef<{ key: string | null; seconds: number }>({ key: null, seconds: 0 });
  if (elapsedRef.current.key !== recKey) elapsedRef.current = { key: recKey, seconds: 0 };
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isActivelyRecording) return undefined;
    const t = setInterval(() => {
      elapsedRef.current.seconds += 1;
      setTick(x => x + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [isActivelyRecording, recKey]);

  /* Keep the pill live while a job runs. Content scripts get session onChanged
     unreliably, so poll the downloads area directly; reset to the useStorage
     value when idle. */
  const hasActiveJob = Object.values(downloads).some(
    p => ACTIVE_STAGES.has(p.stage) || p.stage === 'recording' || p.stage === 'recording-paused',
  );
  useEffect(() => {
    if (!hasActiveJob && !busyUrl) {
      setPolled(null);
      return undefined;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        // Pull from the background (authoritative, fresh) rather than reading
        // chrome.storage.session directly — content scripts see session writes
        // staler than extension pages, which made the pill % lag the side panel.
        const res = await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.GET_DOWNLOADS });
        if (!cancelled && res?.ok) setPolled((res.downloads ?? {}) as Record<string, MediaDownloadProgress>);
      } catch {
        /* background asleep / no receiver — keep last value */
      }
    };
    void poll();
    const t = setInterval(poll, 350);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [hasActiveJob, busyUrl]);

  const interceptModal = intercept ? <InterceptModal intercept={intercept} onClose={() => setIntercept(null)} /> : null;

  if (tabItems.length === 0 || dismissed) return interceptModal;

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
    .reduce<
      VideoEntry | undefined
    >((b, c) => (!b ? c : c.rect.width * c.rect.height > b.rect.width * b.rect.height ? c : b), undefined);

  /* Hysteresis */
  let effectiveVideo = mainVideo;
  if (!mainVideo && (open || isHovered || isBusy)) {
    effectiveVideo = prevVideoRef.current;
  }
  if (effectiveVideo) {
    prevVideoRef.current = effectiveVideo;
  }

  // Anchor the pill to the page <video> when we can find one; otherwise pin it
  // to the top-right corner so it still appears on players we can't anchor to
  // (canvas / shadow-DOM / iframe players like VK). Previously we hid the pill
  // entirely when no <video> was found, which is why VK showed no download pill.
  const vr = effectiveVideo?.rect;
  const right = vr ? window.innerWidth - vr.right + 8 : 12;
  const top = vr ? vr.top + 8 : 12;

  const prog = activeItem ? (downloads[activeItem.url] ?? null) : null;

  /* percentage calc */
  // mux/finalize stages run after byte download is 100%. If the libav build
  // exposes ffmpeg_get_out_time_ms (it doesn't currently), muxPercent is set
  // and we show it. Otherwise pct is null → the pill renders an indeterminate
  // spinner instead of a stale "100%" that looks stuck.
  const isMuxing = prog?.stage === 'mux' || prog?.stage === 'finalize';
  const pct = isMuxing
    ? (prog?.muxPercent ?? null)
    : prog?.estimatedBytes
      ? Math.min(100, Math.round((prog.downloadedBytes / prog.estimatedBytes) * 100))
      : null;

  const stageShort: Record<string, string> = {
    init: 'Downloading…',
    'fetch-manifest': 'Downloading…',
    'download-video': 'Downloading…',
    'download-audio': 'Downloading…',
    mux: 'Processing…',
    finalize: 'Saving…',
    success: '✓ Done',
    failed: '✗ Failed',
  };

  const rows = buildRows(tabItems);
  const bestVariant = primary.variants?.length ? pickBestVariant(primary.variants) : undefined;
  const bestUrl = bestVariant?.url ?? primary.variants?.[0]?.url ?? primary.url;
  const bestQLabel = bestVariant ? qLabel(bestVariant) : '';
  const isLive = !!primary.isLive;
  const elapsed = elapsedRef.current.seconds;

  return (
    <>
      {interceptModal}
      <div
        ref={ref}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{ position: 'fixed', top, right, zIndex: 2147483647, pointerEvents: 'auto', fontFamily: FONT }}>
        <PillBar
          isBusy={isBusy}
          prog={prog}
          pct={pct}
          bestUrl={bestUrl}
          bestQLabel={bestQLabel}
          open={open}
          stageShort={stageShort}
          isLive={isLive}
          elapsed={elapsed}
          onMainClick={() => {
            if (isBusy) {
              if (activeItem) doCancel(activeItem.url);
            } else {
              doDownload(primary, bestUrl);
            }
          }}
          onToggleOpen={() => setOpen(o => !o)}
          onDismiss={() => setDismissed(true)}
          onRecord={() => doRecord(primary)}
          onPauseResume={() => activeItem && doPauseResume(activeItem.url, prog?.stage === 'recording-paused')}
          onStopRecord={() => activeItem && doStopRecord(activeItem.url)}
          onDiscardRecord={() => activeItem && doDiscardRecord(activeItem.url)}
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
    </>
  );
};

export default App;
