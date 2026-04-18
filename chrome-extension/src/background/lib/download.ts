import { capturedRequestHeaders, injectHeadersForDownload, removeHeadersForDownload } from './header-capture';
import { addHistoryEntry } from './history';
import { dlLog } from './logger';
import { createId, deriveKind, deriveFileName, isHlsKind, isDashKind, sanitizeFileName } from './media-utils';
import { updateProgress } from './progress';
import { buildFilenameContext, renderFilenameTemplate } from '@extension/shared';
import { mediaSettingsStorage } from '@extension/storage';
import type { MEDIA_MESSAGE, MediaItem, MediaMessage, SubtitleFormat } from '@extension/shared';

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

export const handleDownload = async (
  payload: Extract<MediaMessage, { type: typeof MEDIA_MESSAGE.DOWNLOAD }>['payload'],
) => {
  dlLog('handleDownload: clicked download in popup', payload);

  // Subtitle fast-path: small text blobs, no offscreen, no progress state, no headers.
  // Route straight to chrome.downloads with a language-suffixed filename.
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
  // time. Reject before spinning up the offscreen doc / libav — libav has no CDM and
  // the user will only see a cryptic mid-mux failure otherwise.
  if (payload.item?.isDrmProtected) {
    const msg = 'DRM-protected stream cannot be downloaded';
    dlLog('handleDownload: DRM-protected, rejecting', payload.item);
    return { ok: false, error: msg } as const;
  }

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
    return { ok: true, downloadId } as const;
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === 'AbortError' || /cancel/i.test(error.message));
    const wasPaused = pauseIntents.delete(key);

    if (isAbort) {
      const stage = wasPaused ? 'paused' : 'cancelled';
      dlLog(`handleDownload: ${stage}`);
      await updateProgress(key, { stage, downloadedBytes: 0 });
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
    return { ok: false, error: error instanceof Error ? error.message : String(error) } as const;
  } finally {
    await removeHeadersForDownload(key);
  }
};

export const pauseDownload = (key: string) => {
  pauseIntents.add(key);
  chrome.runtime.sendMessage({ type: 'offscreen/cancel', payload: { key } }).catch(() => undefined);
};

export const cancelDownload = (key: string) => {
  pauseIntents.delete(key);
  chrome.runtime.sendMessage({ type: 'offscreen/cancel', payload: { key } }).catch(() => undefined);
};
