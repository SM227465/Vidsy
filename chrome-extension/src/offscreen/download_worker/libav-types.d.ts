// Minimal ambient typings for libav.js 6.5.7.1 h264-aac-mp3 variant.
// We only declare the surface we actually call from libav.ts — extend as needed.

interface LibAVInstance {
  onwrite?: (name: string, pos: number, buf: Uint8Array) => void | Promise<void>;
  onread?: (name: string, pos: number, len: number) => Uint8Array | null | Promise<Uint8Array | null>;
  onblockread?: (name: string, pos: number, len: number) => void | Promise<void>;

  mkwriterdev(name: string, mode?: number): Promise<void>;
  mkreaderdev(name: string, mode?: number): Promise<void>;
  unlinkreadaheadfile(name: string): Promise<void>;

  ffmpeg(...args: string[]): Promise<number>;
  ffmpeg_main(...args: string[]): Promise<number>;

  // Optional jsfetch tunables — present in libav.js builds newer than 6.8.8.0.
  // The vendored bundle doesn't ship these; registerJsfetch calls each via a
  // typeof-function guard so the mux still works on older builds.
  jsfetch_set_read_timeout?: (ms: number) => Promise<void>;
  jsfetch_set_fetch_timeout?: (ms: number) => Promise<void>;
  jsfetch_set_initial_retry_delay?: (ms: number) => Promise<void>;
  jsfetch_set_bypass_cache?: (flag: number) => Promise<void>;

  // Optional progress / cancellation helpers — exposed by custom libav.js
  // builds but absent from the vendored h264-aac-mp3 wasm. Callers check
  // `typeof === 'function'` before using.
  ffmpeg_get_out_time_ms?: () => Promise<number>;
  ffmpeg_get_total_size_bytes?: () => Promise<number>;
  ffmpeg_interrupt?: () => Promise<void>;

  AVERROR_EOF: number;

  terminate(): void;
}

interface LibAVOptions {
  noworker?: boolean;
  nothreads?: boolean;
  yesworker?: boolean;
  yesthreads?: boolean;
  base?: string;
  variant?: string;
}

interface LibAVFactory {
  (opts?: LibAVOptions): Promise<LibAVInstance>;
  base: string;
}

declare global {
  interface Window {
    LibAV?: LibAVFactory;
  }

  var LibAV: LibAVFactory | undefined;
}

export type { LibAVInstance, LibAVOptions, LibAVFactory };
