import 'webextension-polyfill';
import { cleanupBlob } from './lib/blob-cleanup';
import { downloadDashMuxed } from './lib/dash-download';
import { downloadHlsMuxed } from './lib/hls-download';
import { downloadHttpDirect } from './lib/http-download';
import { downloadMerged } from './lib/merged-download';
import { activeAbortControllers } from './lib/segment-fetcher';
import { getOpfsFile, muxInWorker, removeOpfs } from './lib/worker-client';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'offscreen/cleanup-blob') {
    void cleanupBlob(message.payload.blobUrl).finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'offscreen/cancel') {
    const { key } = message.payload;
    const controller = activeAbortControllers.get(key);
    if (controller) {
      controller.abort();
      activeAbortControllers.delete(key);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'offscreen/libav-spike') {
    // Phase 2 smoke test — not used by the download dispatcher. Trigger from
    // the SW console: chrome.runtime.sendMessage({ type: 'offscreen/libav-spike',
    // payload: { url: '<public HLS URL>' } })
    const { url, outputOpfsName = `spike-${Date.now().toString(36)}.mp4` } = message.payload ?? {};
    const key = `libav-spike-${Date.now().toString(36)}`;
    (async () => {
      try {
        const ffmpegArgs = ['-f', 'hls', '-i', `jsfetch:${url}`, '-c', 'copy', '-y', outputOpfsName];
        const { totalBytes } = await muxInWorker({ jobKey: key, outputOpfsName, ffmpegArgs });
        const file = await getOpfsFile(outputOpfsName);
        const blobUrl = URL.createObjectURL(file);
        sendResponse({ ok: true, blobUrl, totalBytes, outputOpfsName });
      } catch (err) {
        await removeOpfs(outputOpfsName).catch(() => undefined);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'offscreen/download-blob') {
    const { kind, url, fileName, output, key, headers, audioUrl, videoMimeType, audioMimeType } = message.payload;
    const handle = (p: Promise<{ blobUrl: string; ext: string }>) =>
      p
        .then(result => sendResponse({ ok: true, blobUrl: result.blobUrl, ext: result.ext }))
        .catch(err => sendResponse({ ok: false, error: String(err) }));

    if (kind === 'hls') {
      handle(downloadHlsMuxed(url, fileName, output, key, headers));
    } else if (kind === 'dash') {
      handle(downloadDashMuxed(url, fileName, output, key, headers));
    } else if (kind === 'merged') {
      handle(downloadMerged(url, audioUrl, videoMimeType, audioMimeType, key));
    } else if (kind === 'http') {
      void headers;
      handle(downloadHttpDirect(url, key, output));
    }
    return true;
  }
  return false;
});
