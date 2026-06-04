import { cancelQueued, enqueueDownload, setQueueRunner } from './download-queue';
import { capturedRequestHeaders, injectHeadersForDownload, removeHeadersForDownload } from './header-capture';
import { addHistoryEntry } from './history';
import { dlLog } from './logger';
import { createId, deriveKind, deriveFileName, isHlsKind, isDashKind, sanitizeFileName } from './media-utils';
import { updateProgress } from './progress';
import { buildFilenameContext, renderFilenameTemplate } from '@extension/shared';
import { mediaDownloadsStorage, mediaResumablesStorage, mediaSettingsStorage } from '@extension/storage';
import type { MEDIA_MESSAGE, MediaDownloadProgress, MediaItem, MediaMessage, SubtitleFormat } from '@extension/shared';

// Canonical input OPFS filename for HTTP-range downloads. Must stay in sync with
// opfsNameFor(key, 'in', 'bin') in chrome-extension/src/offscreen/lib/http-download.ts —
// the offscreen worker writes to this file, and the OPFS GC reads this name
// from the resume manifest to decide what to spare on offscreen-doc startup.
const httpInputOpfsName = (key: string): string => `http-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-in.bin`;

let offscreenCreated = false;

// downloadId → blobUrl for OPFS-backed blobs that need offscreen-side cleanup
// once the browser download completes or is cancelled.
const opfsBackedDownloads = new Map<number, string>();

const trackOpfsBackedDownload = (downloadId: number | undefined, blobUrl: string) => {
  if (typeof downloadId === 'number') opfsBackedDownloads.set(downloadId, blobUrl);
};

const triggerBlobCleanup = (blobUrl: string) => {
  chrome.runtime.sendMessage({ type: 'offscreen/cleanup-blob', payload: { blobUrl } }).catch(() => undefined);
};

const handleDownloadStateChange = (delta: chrome.downloads.DownloadDelta) => {
  if (!delta.state?.current) return;
  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const blobUrl = opfsBackedDownloads.get(delta.id);
  if (!blobUrl) return;
  opfsBackedDownloads.delete(delta.id);
  triggerBlobCleanup(blobUrl);
};

chrome.downloads.onChanged.addListener(handleDownloadStateChange);

// Keys that the user paused (intent to resume) — distinct from hard cancels.
// Consulted in handleDownload's catch block to decide the final stage.
const pauseIntents = new Set<string>();

const ensureOffscreen = async () => {
  if (offscreenCreated) return;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length > 0) {
      offscreenCreated = true;
      return;
    }
  } catch {
    // getContexts may not be available in older Chrome versions
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'libav.js OPFS-streaming mux for HLS/DASH/HTTP downloads',
  });
  offscreenCreated = true;
};

// The downloading logic was moved to offscreen/index.ts
// because Service Workers cannot use URL.createObjectURL()
const sendMessageWithRetry = async (msg: Record<string, unknown>, retries = 10) => {
  for (let i = 0; i < retries; i++) {
    try {
      dlLog(`sendMessageWithRetry: sending attempt ${i + 1}`, msg.type);
      const res = await chrome.runtime.sendMessage(msg);
      dlLog(`sendMessageWithRetry: got response`, res);
      return res;
    } catch (err: unknown) {
      dlLog(`sendMessageWithRetry: error on attempt ${i + 1}`, err);
      if (err instanceof Error && err.message?.includes('Receiving end does not exist') && i < retries - 1) {
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }
};

const ensureExt = (name: string, ext: string) => {
  if (name.toLowerCase().endsWith(ext)) return name;
  return `${name}${ext}`;
};

const deriveSubtitleFormat = (url: string): SubtitleFormat => {
  const lower = url.toLowerCase();
  if (lower.includes('.srt')) return 'srt';
  if (lower.includes('.ttml') || lower.includes('.dfxp')) return 'ttml';
  if (lower.includes('fmt=vtt') || lower.includes('.vtt')) return 'vtt';
  // YouTube timedtext without fmt= is XML
  if (lower.includes('/timedtext')) return 'xml';
  return 'vtt';
};

const downloadSubtitle = async (
  url: string,
  fileName: string | undefined,
  title: string | undefined,
  lang: string | undefined,
  format: SubtitleFormat,
) => {
  dlLog('downloadSubtitle: start', { url, fileName, lang, format });
  const ext = format === 'xml' ? '.xml' : `.${format}`;
  const base = fileName ? fileName.replace(/\.[a-z0-9]{1,5}$/i, '') : sanitizeFileName(title ?? 'subtitle');
  const withLang = lang ? `${base}.${lang}` : base;
  const finalName = ensureExt(withLang, ext);
  return chrome.downloads.download({
    url,
    filename: finalName,
    conflictAction: 'uniquify',
    saveAs: false,
  });
};

const downloadDirect = async (
  url: string,
  fileName?: string,
  key?: string,
  output: 'mp4' | 'mp3' = 'mp4',
  headers?: Record<string, string>,
) => {
  dlLog('downloadDirect: start', { url, fileName, output, headers });
  await ensureOffscreen();
  const res = await sendMessageWithRetry({
    type: 'offscreen/download-blob',
    payload: { kind: 'http', url, key: key ?? url, output, headers },
  });
  if (!res?.ok) throw new Error(res?.error || 'Download failed in offscreen');

  const ext = res.ext || (output === 'mp3' ? '.mp3' : '.mp4');
  dlLog('downloadDirect: trigger final browser download', { blobUrl: res.blobUrl, ext });
  const downloadId = await chrome.downloads.download({
    url: res.blobUrl,
    filename: ensureExt(fileName ?? 'download', ext),
    conflictAction: 'uniquify',
    saveAs: false,
  });
  trackOpfsBackedDownload(downloadId, res.blobUrl);
  return downloadId;
};

const downloadHlsMuxed = async (
  playlistUrl: string,
  fileName: string,
  output: 'mp4' | 'mp3',
  key: string,
  headers?: Record<string, string>,
) => {
  dlLog('downloadHlsMuxed: start', { playlistUrl, output, key, headers });
  await ensureOffscreen();
  const res = await sendMessageWithRetry({
    type: 'offscreen/download-blob',
    payload: { kind: 'hls', url: playlistUrl, fileName, output, key, headers },
  });
  if (chrome.runtime.lastError) throw chrome.runtime.lastError;
  if (!res?.ok) throw new Error(res?.error || 'Download failed in offscreen');

  const ext = res.ext || (output === 'mp3' ? '.mp3' : '.mp4');
  dlLog('downloadHlsMuxed: trigger final browser download', { blobUrl: res.blobUrl, ext });
  const downloadId = await chrome.downloads.download({
    url: res.blobUrl,
    filename: ensureExt(fileName, ext),
    conflictAction: 'uniquify',
    saveAs: false,
  });
  trackOpfsBackedDownload(downloadId, res.blobUrl);
  return downloadId;
};

const downloadMergedCall = async (
  videoUrl: string,
  audioUrl: string,
  fileName: string,
  key: string,
  videoMimeType?: string,
  audioMimeType?: string,
) => {
  dlLog('downloadMergedCall: start', { videoUrl, audioUrl, key });
  await ensureOffscreen();
  const res = await sendMessageWithRetry({
    type: 'offscreen/download-blob',
    payload: { kind: 'merged', url: videoUrl, audioUrl, fileName, key, videoMimeType, audioMimeType },
  });
  if (chrome.runtime.lastError) throw chrome.runtime.lastError;
  if (!res?.ok) throw new Error(res?.error || 'Merged download failed in offscreen');
  dlLog('downloadMergedCall: trigger final browser download', { blobUrl: res.blobUrl, ext: res.ext });
  const downloadId = await chrome.downloads.download({
    url: res.blobUrl,
    filename: ensureExt(fileName, res.ext || '.mp4'),
    conflictAction: 'uniquify',
    saveAs: false,
  });
  trackOpfsBackedDownload(downloadId, res.blobUrl);
  return downloadId;
};

const downloadDashMuxed = async (
  manifestUrl: string,
  fileName: string,
  output: 'mp4' | 'mp3',
  key: string,
  headers?: Record<string, string>,
) => {
  dlLog('downloadDashMuxed: start', { manifestUrl, output, key, headers });
  await ensureOffscreen();
  const res = await sendMessageWithRetry({
    type: 'offscreen/download-blob',
    payload: { kind: 'dash', url: manifestUrl, fileName, output, key, headers },
  });
  if (chrome.runtime.lastError) throw chrome.runtime.lastError;
  if (!res?.ok) throw new Error(res?.error || 'Download failed in offscreen');

  const dashExt = res.ext || (output === 'mp3' ? '.mp3' : '.mp4');
  dlLog('downloadDashMuxed: trigger final browser download', { blobUrl: res.blobUrl, ext: dashExt });
  const downloadId = await chrome.downloads.download({
    url: res.blobUrl,
    filename: ensureExt(fileName, dashExt),
    conflictAction: 'uniquify',
    saveAs: false,
  });
  trackOpfsBackedDownload(downloadId, res.blobUrl);
  return downloadId;
};

type DownloadPayload = Extract<MediaMessage, { type: typeof MEDIA_MESSAGE.DOWNLOAD }>['payload'];

const runDownloadJob = async (payload: DownloadPayload) => {
  dlLog('runDownloadJob: starting', payload);

  const settings = await mediaSettingsStorage.get();

  // Safety-net: if stored fileName looks like a raw URL segment (e.g. _TPL_.av1.mp4.m3u8),
  // prefer deriving from title so the user gets a human-readable filename.
  const URL_SEGMENT_RE = /\.(m3u8|mpd|m4s|ts)(\.|$)/i;
  const rawFileName = payload.fileName;
  const fallbackFileName =
    rawFileName && !URL_SEGMENT_RE.test(rawFileName) && !rawFileName.includes('_TPL_')
      ? rawFileName
      : deriveFileName(payload.url, payload.title);

  // Apply user's filename template when set. The downloader still appends the
  // correct extension via ensureExt, so the template can omit {ext} safely.
  const outputFormatForTemplate = payload.outputFormat ?? 'mp4';
  const kindForTemplate = payload.kind ?? deriveKind(payload.url);
  const templatedFileName = settings.filenameTemplate
    ? renderFilenameTemplate(
        settings.filenameTemplate,
        buildFilenameContext(
          {
            title: payload.title ?? payload.item?.title,
            kind: kindForTemplate,
            pageUrl: payload.item?.pageUrl,
            url: payload.url,
            variants: payload.item?.variants,
          },
          { ext: outputFormatForTemplate },
        ),
      )
    : undefined;
  const fileName = templatedFileName ?? fallbackFileName;
  const mediaItem: MediaItem = payload.item
    ? {
        ...payload.item,
        fileName,
        title: payload.title ?? payload.item.title,
        tabId: payload.tabId ?? payload.item.tabId,
      }
    : {
        id: createId(),
        url: payload.url,
        kind: deriveKind(payload.url, undefined),
        detectedAt: Date.now(),
        source: 'network',
        fileName,
        title: payload.title,
        tabId: payload.tabId,
      };

  const key = payload.key ?? payload.url;

  // Persist an initial "init" entry so the Downloads tab can render the item immediately
  await updateProgress(
    key,
    { stage: 'init', downloadedBytes: 0 },
    { item: mediaItem, outputFormat: payload.outputFormat ?? 'mp4' },
  );

  // Retrieve captured headers (cookies, referer) for this URL
  const captured = capturedRequestHeaders.get(payload.url)?.headers ?? capturedRequestHeaders.get(key)?.headers;
  dlLog('handleDownload: finding headers for request', captured ?? 'No captured headers found');

  // Inject Referer/Origin headers via declarativeNetRequest for CDN segment fetches
  if (captured && Object.keys(captured).length > 0) {
    await injectHeadersForDownload(payload.url, captured, key);
  }

  try {
    const outputFormat = payload.outputFormat ?? 'mp4';
    // HLS must always be muxed — direct download saves the m3u8 playlist as HTML
    const shouldMergeHls = isHlsKind(payload.kind, payload.url);
    const shouldMergeDash = isDashKind(payload.kind, payload.url) && settings.enableHlsMerging;
    const shouldMergeAV = !!payload.audioUrl && !shouldMergeHls && !shouldMergeDash;

    dlLog('handleDownload: processing strategy', { shouldMergeHls, shouldMergeDash, shouldMergeAV });

    const downloadId = shouldMergeHls
      ? await downloadHlsMuxed(payload.url, fileName, outputFormat, key, captured)
      : shouldMergeDash
        ? await downloadDashMuxed(payload.url, fileName, outputFormat, key, captured)
        : shouldMergeAV
          ? await downloadMergedCall(
              payload.url,
              payload.audioUrl!,
              fileName,
              key,
              payload.item?.mimeType,
              payload.audioMimeType,
            )
          : await downloadDirect(payload.url, fileName, key, outputFormat, captured);

    dlLog('handleDownload: success', { downloadId });
    await updateProgress(key, { stage: 'success', downloadedBytes: 0, downloadId: downloadId ?? undefined });
    await addHistoryEntry(mediaItem, 'success', undefined, downloadId ?? undefined);
    // Successful completion — drop any cross-session resume manifest for this key.
    void dropResumeManifest(key).catch(() => undefined);
    return { ok: true, downloadId } as const;
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === 'AbortError' || /cancel/i.test(error.message));
    const wasPaused = pauseIntents.delete(key);

    if (isAbort) {
      const stage = wasPaused ? 'paused' : 'cancelled';
      dlLog(`handleDownload: ${stage}`);
      // On pause: keep the existing downloadedBytes count so the UI shows
      // where we left off (the chunks are still on disk and will be reused
      // on resume). On cancel: reset to 0 — the OPFS file is purged anyway.
      // Cast to the shared shape — the storage package's local type copy
      // lacks `chunks` / `queuePosition`, but the runtime data is authored
      // by progress.ts using the shared MediaDownloadProgress.
      const entry = (await mediaDownloadsStorage.get())[key] as MediaDownloadProgress | undefined;
      const preservedBytes = wasPaused ? (entry?.downloadedBytes ?? 0) : 0;
      await updateProgress(key, { stage, downloadedBytes: preservedBytes });
      if (wasPaused) {
        void writeResumeManifest(key, payload, mediaItem, entry).catch(err =>
          dlLog('writeResumeManifest failed (non-fatal)', err),
        );
      } else {
        void dropResumeManifest(key).catch(() => undefined);
      }
      return { ok: false, cancelled: true, paused: wasPaused } as const;
    }

    dlLog('handleDownload: failed with error', error);
    console.error('Download failed', error);
    await updateProgress(key, {
      stage: 'failed',
      downloadedBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    await addHistoryEntry(mediaItem, 'failed', error instanceof Error ? error.message : String(error));
    void dropResumeManifest(key).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) } as const;
  } finally {
    await removeHeadersForDownload(key);
  }
};

// Build and persist a ResumeManifest from the session-storage snapshot at pause
// time. Only HTTP-range downloads carry the chunks array we need; everything
// else (HLS / DASH / merged) is skipped — cross-session resume for those needs
// segment-state + manifest re-validation and is out of scope for Sprint 11.
const writeResumeManifest = async (
  key: string,
  payload: DownloadPayload,
  item: MediaItem,
  entry: MediaDownloadProgress | undefined,
): Promise<void> => {
  if (!entry?.chunks || entry.chunks.length === 0) return;
  if (!entry.estimatedBytes || entry.estimatedBytes <= 0) return;
  const settings = await mediaSettingsStorage.get();
  const retentionDays = Math.max(1, Math.min(30, Math.floor(settings.pausedDownloadRetentionDays ?? 7)));
  const now = Date.now();
  const manifest = {
    key,
    url: payload.url,
    fileName: payload.fileName,
    title: payload.title,
    item,
    outputFormat: payload.outputFormat,
    opfsName: httpInputOpfsName(key),
    totalBytes: entry.estimatedBytes,
    ranges: entry.chunks.map(c => ({ start: c.start, end: c.end })),
    chunks: entry.chunks,
    downloadedBytes: entry.downloadedBytes,
    pausedAt: now,
    expiresAt: now + retentionDays * 86_400_000,
  };
  await mediaResumablesStorage.set(prev => ({ ...prev, [key]: manifest }));
};

const dropResumeManifest = async (key: string): Promise<void> => {
  await mediaResumablesStorage.set(prev => {
    if (!(key in prev)) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  });
};

// Register the queue runner now that runDownloadJob is defined. The queue
// invokes this for each pending job when concurrency allows — see download-queue.ts.
setQueueRunner(runDownloadJob);

// Hard reject downloads pointed at hosts whose content policies forbid third-
// party downloaders from operating. This is defense-in-depth on top of the
// content-script exclude_matches in the manifest and the host blocklists in
// detection.ts / paste-url.ts — every entry point that reaches the download
// pipeline must end here, so we refuse a download regardless of which UI path
// triggered it.
const RESTRICTED_HOST_SUFFIXES = ['.youtube.com', '.youtube-nocookie.com', '.googlevideo.com', '.ytimg.com'];

const isRestrictedDownloadUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'youtube.com' || host === 'youtu.be') return true;
    return RESTRICTED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
  } catch {
    return false;
  }
};

export const handleDownload = async (payload: DownloadPayload) => {
  dlLog('handleDownload: enqueue request', payload);

  if (isRestrictedDownloadUrl(payload.url)) {
    dlLog('handleDownload: refusing — restricted host', payload.url);
    return { ok: false, error: 'This platform is not supported.' } as const;
  }

  // Subtitle fast-path: small text blobs, no offscreen, no progress state, no headers.
  // Route straight to chrome.downloads with a language-suffixed filename. These don't
  // belong in the long-running queue — they finish in milliseconds.
  if (payload.kind === 'subtitle') {
    try {
      const format = payload.subtitleFormat ?? deriveSubtitleFormat(payload.url);
      const downloadId = await downloadSubtitle(
        payload.url,
        payload.fileName,
        payload.title,
        payload.subtitleLang,
        format,
      );
      return { ok: true, downloadId } as const;
    } catch (error) {
      dlLog('handleDownload: subtitle failed', error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) } as const;
    }
  }

  // DRM pre-dispatch gate: manifest-parser flags DRM-protected variants at detection
  // time. Reject before queueing — there's no point making the user wait through the
  // queue only to fail; we fail fast here.
  if (payload.item?.isDrmProtected) {
    const msg = 'DRM-protected stream cannot be downloaded';
    dlLog('handleDownload: DRM-protected, rejecting', payload.item);
    return { ok: false, error: msg } as const;
  }

  // Build a minimal MediaItem snapshot for the queue UI. Full filename templating
  // and metadata expansion happens inside runDownloadJob when this job becomes
  // active — keeps the enqueue path cheap.
  const queuedItem: MediaItem = payload.item
    ? { ...payload.item, tabId: payload.tabId ?? payload.item.tabId }
    : {
        id: createId(),
        url: payload.url,
        kind: payload.kind ?? deriveKind(payload.url, undefined),
        detectedAt: Date.now(),
        source: 'network',
        title: payload.title,
        fileName: payload.fileName,
        tabId: payload.tabId,
      };

  await enqueueDownload(payload, queuedItem);
  return { ok: true, queued: true } as const;
};

export const pauseDownload = (key: string) => {
  pauseIntents.add(key);
  chrome.runtime.sendMessage({ type: 'offscreen/cancel', payload: { key } }).catch(() => undefined);
};

export const cancelDownload = (key: string) => {
  pauseIntents.delete(key);
  // If the job is still queued (not yet running), remove it from the queue and
  // clear progress. Otherwise the offscreen cancel below aborts the running mux.
  void cancelQueued(key);
  chrome.runtime.sendMessage({ type: 'offscreen/cancel', payload: { key } }).catch(() => undefined);
  // Always drop any cross-session resume manifest. Three cases:
  // (1) job currently running — the catch block also drops; harmless double-drop.
  // (2) job queued — no manifest existed; no-op.
  // (3) entry already in 'paused' state — this IS the user discarding the
  //     paused download. Without this drop, the manifest would survive and
  //     the popup would keep showing it as resumable on next session.
  void dropResumeManifest(key).catch(() => undefined);
};
