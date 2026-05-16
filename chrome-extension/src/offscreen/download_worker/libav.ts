// libav.js factory + output-device + jsfetch registrars.
// Runs inside the download worker. Binds libav's mkwriterdev onwrite callback
// to OPFS writeAt() so mux output never lands in WASM MEMFS.

import { installLibAVGlobals } from './libav-globals';
import { opfs } from './opfs';
import type { LibAVInstance } from './libav-types';

// libav.js ships two layered modules per variant:
//   - The wasm.mjs is the Emscripten-generated wasm loader (low-level Module
//     exports like `_ffmpeg_main`, `mkwriterdev` strings, etc.)
//   - The wrapper .mjs (default-cli variant for ffmpeg CLI access) loads the
//     wasm.mjs internally and decorates the Module with promise-wrapped
//     high-level methods (`ffmpeg`, `mkwriterdev`, `terminate`, …).
//
// We previously only vendored the wasm.mjs and imported it directly — that
// returned the bare Emscripten Module without any of the decorated methods,
// causing `libav.ffmpeg(...)` to throw "ffmpeg is not a function". Switching
// to the wrapper restores the full API. The wrapper is variant-agnostic and
// auto-discovers our custom h264-aac-mp3.wasm.mjs via base + variant.
//
// Dedicated workers don't expose `chrome.*`, so resolve every extension URL
// relative to the worker script's own location (chrome-extension://<id>/download_worker/main.js).
const LIBAV_WRAPPER_URL = new URL('../libav/libav-6.8.8.0-h264-aac-mp3-cli.mjs', self.location.href).href;
const LIBAV_BASE_URL = new URL('../libav/', self.location.href).href;
const LIBAV_VARIANT = 'h264-aac-mp3-cli';

installLibAVGlobals();

type LibAVWrapper = {
  LibAV: (opts?: {
    noworker?: boolean;
    nothreads?: boolean;
    base?: string;
    variant?: string;
  }) => Promise<LibAVInstance>;
};

let wrapperPromise: Promise<LibAVWrapper> | null = null;

const loadWrapper = async (): Promise<LibAVWrapper> => {
  if (wrapperPromise) return wrapperPromise;
  wrapperPromise = (async () => {
    // Prime the global LibAV.base so the wrapper can find our wasm.mjs even
    // when import.meta.url resolution falls short under bundler quirks.
    (globalThis as { LibAV?: { base: string; variant?: string } }).LibAV = {
      base: LIBAV_BASE_URL,
      variant: LIBAV_VARIANT,
    };
    const mod = (await import(/* @vite-ignore */ LIBAV_WRAPPER_URL)) as { default: LibAVWrapper };
    return mod.default;
  })();
  return wrapperPromise;
};

export const createLibAV = async (): Promise<LibAVInstance> => {
  const wrapper = await loadWrapper();
  // noworker:true keeps libav on this (download) worker thread. The nested-worker
  // default marshals `onwrite` via postMessage, which breaks mkwriterdev's
  // synchronous write contract and stalls the mux silently. We also disable
  // threads — SharedArrayBuffer works under COEP, but the extra worker pool
  // buys nothing for our serial-mux design.
  return wrapper.LibAV({
    noworker: true,
    nothreads: true,
    base: LIBAV_BASE_URL,
    variant: LIBAV_VARIANT,
  });
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

// jsfetch tunables — sensible defaults for HLS/DASH fetching. All are milliseconds.
export type JsFetchOptions = {
  readTimeoutMs?: number;
  fetchTimeoutMs?: number;
  initialRetryDelayMs?: number;
  bypassCache?: boolean;
};

export const registerJsfetch = async (libav: LibAVInstance, opts: JsFetchOptions = {}): Promise<void> => {
  const { readTimeoutMs = 30_000, fetchTimeoutMs = 30_000, initialRetryDelayMs = 1_000, bypassCache = false } = opts;
  // The vendored libav.js 6.8.8.0 build only ships the jsfetch internals
  // (jsfetch_open_js/read_js/seek_js/close_js/get_filesize_js); the tunable
  // setters were added in later builds. Call them when present so we benefit
  // from them after a future bundle bump, but don't fail the mux if they're
  // missing — libav falls back to its compiled-in defaults (~30s timeouts).
  const callIfPresent = async (name: keyof LibAVInstance, value: number) => {
    const fn = libav[name] as ((v: number) => Promise<void>) | undefined;
    if (typeof fn !== 'function') return;
    await fn.call(libav, value);
  };
  await callIfPresent('jsfetch_set_read_timeout', readTimeoutMs);
  await callIfPresent('jsfetch_set_fetch_timeout', fetchTimeoutMs);
  await callIfPresent('jsfetch_set_initial_retry_delay', initialRetryDelayMs);
  await callIfPresent('jsfetch_set_bypass_cache', bypassCache ? 1 : 0);
};
