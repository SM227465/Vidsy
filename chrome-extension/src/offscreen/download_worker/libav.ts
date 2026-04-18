// libav.js factory + output-device + jsfetch registrars.
// Runs inside the download worker. Binds libav's mkwriterdev onwrite callback
// to OPFS writeAt() so mux output never lands in WASM MEMFS.

import { installLibAVGlobals } from './libav-globals';
import { opfs } from './opfs';
import type { LibAVFactory, LibAVInstance } from './libav-types';

// Dedicated workers don't expose `chrome.*`, so resolve every extension URL
// relative to the worker script's own location (chrome-extension://<id>/download_worker/main.js).
const LIBAV_MJS_URL = new URL('../libav/libav-6.5.7.1-h264-aac-mp3.wasm.mjs', self.location.href).href;
const LIBAV_BASE_URL = new URL('../libav/', self.location.href).href;

installLibAVGlobals();

// Cache the dynamic import so warm-starts skip re-parse of the 300 KB loader.
let factoryPromise: Promise<LibAVFactory> | null = null;

const loadFactory = async (): Promise<LibAVFactory> => {
  if (factoryPromise) return factoryPromise;
  factoryPromise = (async () => {
    // Prime the global LibAV.base fallback in case the loader's
    // import.meta.url path fails (defensive; normally unused).
    (globalThis as { LibAV?: { base: string } }).LibAV = { base: LIBAV_BASE_URL };
    const mod = (await import(/* @vite-ignore */ LIBAV_MJS_URL)) as { default: LibAVFactory };
    return mod.default;
  })();
  return factoryPromise;
};

export const createLibAV = async (): Promise<LibAVInstance> => {
  const factory = await loadFactory();
  // noworker:true keeps libav on this (download) worker thread. The nested-worker
  // default marshals `onwrite` via postMessage, which breaks mkwriterdev's
  // synchronous write contract and stalls the mux silently. We also disable
  // threads — SharedArrayBuffer works under COEP, but the extra worker pool
  // buys nothing for our serial-mux design.
  return factory({ noworker: true, nothreads: true });
};

// Wire the output device: every libav onwrite(name, pos, buf) becomes an
// OPFS writeAt at the exact offset libav requested. Random-offset writes
// (e.g. -movflags +faststart moov patch-up) land correctly thanks to Phase 1.
export const registerOutputDevice = async (libav: LibAVInstance, opfsName: string): Promise<void> => {
  await opfs.open(opfsName);
  let writeCount = 0;
  let bytesWritten = 0;
  libav.onwrite = (name, pos, buf) => {
    if (name !== opfsName) return;
    try {
      opfs.writeAt(opfsName, pos, buf);
      writeCount++;
      bytesWritten += buf.byteLength;
      if (writeCount === 1 || writeCount % 100 === 0) {
        console.log(
          `[libav] onwrite #${writeCount} name=${name} pos=${pos} len=${buf.byteLength} total=${bytesWritten}`,
        );
      }
    } catch (err) {
      console.error(`[libav] onwrite failed at pos=${pos} len=${buf.byteLength}:`, err);
      throw err;
    }
  };
  console.log(`[libav] registering writer device for ${opfsName}`);
  await libav.mkwriterdev(opfsName);
  console.log(`[libav] writer device ready for ${opfsName}`);
};

// jsfetch tunables — match VDH's defaults. All are milliseconds.
export type JsFetchOptions = {
  readTimeoutMs?: number;
  fetchTimeoutMs?: number;
  initialRetryDelayMs?: number;
  bypassCache?: boolean;
};

export const registerJsfetch = async (libav: LibAVInstance, opts: JsFetchOptions = {}): Promise<void> => {
  const { readTimeoutMs = 30_000, fetchTimeoutMs = 30_000, initialRetryDelayMs = 1_000, bypassCache = false } = opts;
  await libav.jsfetch_set_read_timeout(readTimeoutMs);
  await libav.jsfetch_set_fetch_timeout(fetchTimeoutMs);
  await libav.jsfetch_set_initial_retry_delay(initialRetryDelayMs);
  await libav.jsfetch_set_bypass_cache(bypassCache ? 1 : 0);
};
