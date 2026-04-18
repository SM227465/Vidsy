// Shared helpers for libav-based mux strategies (HLS / DASH / HTTP MP3 /
// merged). Consolidates the auth-fallback decision and the OPFS→jsfetch
// input conversion so every strategy branches the same way.
//
// DNR note: the dynamic rule at background/lib/header-capture.ts omits
// `resourceTypes`, which in MV3 matches every resource type except
// main_frame — so libav's worker-origin fetch (`xmlhttprequest`) is
// already header-injected by the existing DNR writer. No DNR change
// needed for the libav swap.

import { getOpfsFile } from './worker-client';

// Auth-fallback is required when the SW captured any request headers for
// the source URL (Cookie / Referer / Origin / Authorization). DNR rewrites
// those on fetches from the offscreen document and its workers, but it is
// safer to pre-fetch into OPFS and hand libav a blob URL: that lets us see
// the auth response body before libav reads it, and isolates libav from
// header-driven CDN redirects.
export const needsAuthFallback = (headers: Record<string, string> | undefined): boolean =>
  !!headers && Object.keys(headers).length > 0;

// Convert an OPFS entry into a libav jsfetch input string. The worker owns
// OPFS, so we ask it for the File, wrap it in a blob URL, and let libav
// pull bytes through `jsfetch:blob:...`. The caller is responsible for
// revoking the blob URL after the mux returns (or during cleanup).
export const jsfetchInputForOpfs = async (opfsName: string): Promise<{ jsfetchUrl: string; blobUrl: string }> => {
  const file = await getOpfsFile(opfsName);
  const blobUrl = URL.createObjectURL(file);
  return { jsfetchUrl: `jsfetch:${blobUrl}`, blobUrl };
};

// Direct (no-auth) variant: wrap any HTTP(S) URL for libav jsfetch.
export const jsfetchInputForUrl = (url: string): string => `jsfetch:${url}`;

// Best-effort disk preflight. The browser's OPFS pool is shared quota, so we
// refuse to start a mux that clearly cannot fit. We skip silently when the
// Storage API is unavailable (older Chromium, private browsing) — libav's own
// write errors are the last line of defence.
export const preflightDiskSpace = async (requiredBytes: number): Promise<void> => {
  if (requiredBytes <= 0) return;
  if (!navigator.storage?.estimate) return;
  const { quota, usage } = await navigator.storage.estimate();
  if (quota === undefined || usage === undefined) return;
  const available = quota - usage;
  if (available >= requiredBytes) return;
  const reqGb = (requiredBytes / (1024 * 1024 * 1024)).toFixed(2);
  const availGb = (available / (1024 * 1024 * 1024)).toFixed(2);
  throw new Error(`Insufficient disk space: need ~${reqGb} GB free, have ${availGb} GB`);
};

// Sum of #EXTINF values in an HLS variant playlist. Returns undefined when no
// segment durations are declared (e.g. master playlists or malformed inputs).
export const hlsManifestDurationSeconds = (manifestText: string): number | undefined => {
  let total = 0;
  let matched = false;
  for (const line of manifestText.split('\n')) {
    const m = line.match(/^#EXTINF:([\d.]+)/);
    if (m) {
      total += Number(m[1]);
      matched = true;
    }
  }
  return matched ? total : undefined;
};

// Extract `mediaPresentationDuration` (ISO-8601 PnYnMnDTnHnMnS) from an MPD.
// We only handle the time portion since DASH durations are always subday.
export const dashManifestDurationSeconds = (manifestXml: string): number | undefined => {
  const m = manifestXml.match(/mediaPresentationDuration\s*=\s*"([^"]+)"/);
  if (!m) return undefined;
  const dur = m[1].match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!dur) return undefined;
  const seconds = Number(dur[1] ?? 0) * 3600 + Number(dur[2] ?? 0) * 60 + Number(dur[3] ?? 0);
  return seconds > 0 ? seconds : undefined;
};
