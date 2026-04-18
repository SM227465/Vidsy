// Globals that libav.js's jsfetch protocol expects on the worker scope.
// The upstream libav.js wrapper registers these before bootstrapping the
// WASM module; we load the emscripten module directly, so we install them
// by hand. Signatures and retry behaviour match VDH's implementation — the
// WASM side is compiled against them and any deviation crashes silently
// inside the asyncify trampoline (e.g. "ReferenceError: MutateUrl is not
// defined" stalls the mux with no user-visible error).

type SleepResult = { aborted?: true; timed_out?: true; timeout_id?: ReturnType<typeof setTimeout> };

// Awaitable sleep that resolves early on signal abort. Returns a tagged
// object so the caller can distinguish "timed out" from "aborted".
const doAbortableSleep = (ms: number, signal: AbortSignal): Promise<SleepResult> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return new Promise<void>(resolve => {
    const onAbort = (): void => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', onAbort);
    timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  }).then(() =>
    signal.aborted
      ? { aborted: true as const, timeout_id: timeoutId }
      : { timed_out: true as const, timeout_id: timeoutId },
  );
};

type FetchResult = Response | { err_status: number } | { aborted: true } | { timeout: true } | Error;

// Exponential-backoff fetch matching libav's jsfetch contract. Returns the
// first successful Response or a tagged error object. 404/416 short-circuit
// (libav uses those to detect end-of-stream and out-of-range reads).
const fetchWithRetry = async (
  url: string,
  headers: Record<string, string>,
  maxAttempts: number,
  fetchTimeoutMs: number,
  initialRetryDelayMs: number,
  bypassCache: boolean,
  outerSignal: AbortSignal,
): Promise<FetchResult> => {
  const cache: RequestCache = bypassCache ? 'reload' : 'default';
  let lastErr: FetchResult = new Error('FetchWithRetry: no attempts');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const timeoutCtl = new AbortController();
    const combined = AbortSignal.any([timeoutCtl.signal, outerSignal]);
    const timeoutId = setTimeout(() => timeoutCtl.abort(`Timed out after ${fetchTimeoutMs}`), fetchTimeoutMs);
    try {
      const res = await fetch(url, { headers, cache, signal: combined, credentials: 'include' });
      if (res.ok) return res;
      if (res.status === 404 || res.status === 416) return { err_status: res.status };
      lastErr = { err_status: res.status };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return outerSignal.aborted ? { aborted: true } : { timeout: true };
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timeoutId);
    }

    const backoff = Math.pow(2, attempt) * initialRetryDelayMs;
    const sleepResult = await doAbortableSleep(backoff, outerSignal);
    if (sleepResult.aborted) return { aborted: true };
  }
  return lastErr;
};

// Walks a PNG-wrapped payload and returns the byte offset immediately after
// the IEND chunk (used by some CDNs that disguise .m3u8 as .png). Returns -1
// if the buffer isn't a PNG or the IEND sentinel isn't present.
const findPngSliceIndex = (bytes: Uint8Array): number => {
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const IEND = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return -1;
  }
  const needleLen = IEND.length;
  const haystackLen = bytes.length;
  if (needleLen === 0 || needleLen > haystackLen) return -1;
  const first = IEND[0];
  for (let i = PNG_MAGIC.length; i <= haystackLen - needleLen; i++) {
    if (bytes[i] !== first) continue;
    let match = true;
    for (let k = 1; k < needleLen; k++) {
      if (bytes[i + k] !== IEND[k]) {
        match = false;
        break;
      }
    }
    if (match) return i + needleLen;
  }
  return -1;
};

type LibAVGlobals = {
  MutateUrl?: (url: string) => string;
  MAX_FETCH_ATTEMPTS?: number;
  MAX_READ_ATTEMPTS?: number;
  FetchWithRetry?: typeof fetchWithRetry;
  DoAbortableSleep?: typeof doAbortableSleep;
  FindPngSliceIndex?: typeof findPngSliceIndex;
};

let installed = false;
export const installLibAVGlobals = (): void => {
  if (installed) return;
  installed = true;
  const g = globalThis as typeof globalThis & LibAVGlobals;
  g.MutateUrl ??= (u: string) => u;
  g.MAX_FETCH_ATTEMPTS ??= 6;
  g.MAX_READ_ATTEMPTS ??= 6;
  g.FetchWithRetry ??= fetchWithRetry;
  g.DoAbortableSleep ??= doAbortableSleep;
  g.FindPngSliceIndex ??= findPngSliceIndex;
};
