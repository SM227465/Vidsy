import 'webextension-polyfill';
import { cleanupBlob, disarmCleanupFallback } from './lib/blob-cleanup';
import { pauseIntentKeys } from './lib/cancel-intent';
import { downloadDashMuxed } from './lib/dash-download';
import {
  abortDashLiveRecording,
  pauseDashLiveRecording,
  resumeDashLiveRecording,
  startDashLiveRecording,
  stopDashLiveRecording,
} from './lib/dash-live-recorder';
import { downloadHlsMuxed } from './lib/hls-download';
import {
  abortLiveRecording,
  pauseLiveRecording,
  resumeLiveRecording,
  startLiveRecording,
  stopLiveRecording,
} from './lib/hls-live-recorder';
import { downloadHttpDirect } from './lib/http-download';
import { downloadMerged } from './lib/merged-download';
import { purgeOpfsOrphans } from './lib/opfs-gc';
import { activeAbortControllers } from './lib/segment-fetcher';
import { swLog } from './lib/sw-log';
import { getOpfsFile, muxInWorker, removeOpfs } from './lib/worker-client';

// Sweep orphaned OPFS files left over from a prior session (crash,
// browser kill, extension reload). Fire-and-forget so the message
// listener stays responsive for fresh downloads.
void purgeOpfsOrphans().then(({ removed, failed, spared }) => {
  if (removed > 0 || failed > 0 || spared > 0) {
    console.log(`[Vidsy] OPFS GC: removed ${removed}, spared ${spared}, failed ${failed}`);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'offscreen/cleanup-blob') {
    void cleanupBlob(message.payload.blobUrl).finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'offscreen/disarm-cleanup') {
    disarmCleanupFallback(message.payload.blobUrl);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'offscreen/cancel') {
    const { key, intent } = message.payload;
    // Record the intent BEFORE aborting — the abort propagates synchronously
    // into the strategy's catch/finally, which reads this set.
    if (intent === 'pause') pauseIntentKeys.add(key);
    else pauseIntentKeys.delete(key);
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

  if (message.type === 'offscreen/pause-recording') {
    const { key, resume } = message.payload;
    // Call both engines; the one that doesn't own this key is a no-op.
    if (resume) {
      resumeLiveRecording(key);
      resumeDashLiveRecording(key);
    } else {
      pauseLiveRecording(key);
      pauseDashLiveRecording(key);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'offscreen/stop-recording') {
    const { key, discard } = message.payload;
    (async () => {
      try {
        if (discard) {
          await abortLiveRecording(key);
          await abortDashLiveRecording(key);
          sendResponse({ ok: true, discarded: true });
          return;
        }
        // Whichever engine owns the key returns the blob; the other returns null.
        const res = (await stopLiveRecording(key)) ?? (await stopDashLiveRecording(key));
        if (res) sendResponse({ ok: true, blobUrl: res.blobUrl, ext: res.ext });
        else sendResponse({ ok: false, error: 'No active recording for this key' });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'offscreen/download-blob') {
    const { kind, url, fileName, output, key, headers, audioUrl, videoMimeType, audioMimeType } = message.payload;
    swLog('download-blob received', { kind, headerKeys: Object.keys(headers ?? {}) });
    if (kind === 'hls-live') {
      try {
        startLiveRecording({ playlistUrl: url, fileName, output, key, headers });
        sendResponse({ ok: true, recording: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (kind === 'dash-live') {
      try {
        startDashLiveRecording({ manifestUrl: url, fileName, output, key, headers });
        sendResponse({ ok: true, recording: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
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
