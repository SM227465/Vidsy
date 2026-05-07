# Third-party components bundled in this extension

The files `libav-6.8.8.0-h264-aac-mp3.wasm.wasm` and
`libav-6.8.8.0-h264-aac-mp3.wasm.mjs` in this directory are an unmodified
redistribution of a prebuilt WebAssembly artifact that bundles the following
components:

## Bundled components

- **FFmpeg** (libavformat, libavcodec, libavutil, libswscale, libswresample, etc.)
  — LGPL-2.1-or-later.
  Upstream: https://ffmpeg.org/
  Source: https://ffmpeg.org/releases/

- **libmp3lame** (LAME MP3 encoder 3.100)
  — LGPL-2.1-or-later.
  Upstream: https://lame.sourceforge.io/
  Source: https://lame.sourceforge.io/download.php

- **libav.js** (compilation toolchain + JS glue; Yahweasel/libav.js 6.8.8.0)
  — 2-Clause BSD (glue) / LGPL-2.1 (bundled FFmpeg).
  Upstream: https://github.com/Yahweasel/libav.js
  Source: https://github.com/Yahweasel/libav.js/tree/v6.8.8.0

## License

The FFmpeg + libmp3lame portions are distributed under the terms of the GNU
Lesser General Public License, version 2.1 or later. The full license text is
in `LICENSE.LGPL-2.1` in this directory.

Under LGPL-2.1 you are entitled to:
- obtain the complete corresponding source code for the bundled libraries
  (see the upstream source URLs above),
- relink the WebAssembly binary against a modified version of any of the
  bundled LGPL libraries.

The `.wasm` binary in this directory is shipped unmodified and is installed
as a standalone file (not statically linked into extension JavaScript), so it
can be replaced by a user-built equivalent without rebuilding the extension.

## Patent note — H.264

This bundle includes an H.264 *decoder*. H.264 is covered by patents licensed
by MPEG LA. Consult your local counsel before distributing applications that
decode H.264 at scale. This extension uses the decoder only to remux or
transcode content that the end user has already obtained; no H.264 encoding
is performed.

## Patent note — MP3

The MP3 (MPEG-1/2 Audio Layer III) patents expired worldwide by 2017. No
active patent claims apply to libmp3lame redistribution at this time.

## How to rebuild

To produce a replacement artifact, check out
https://github.com/Yahweasel/libav.js at tag `v6.8.8.0` and build the
`h264-aac-mp3` variant per the project's README. The variant configuration
adds HLS demuxing (`format-hls`), the libav-side fetch protocol
(`protocol-jsfetch`), and the H.264 MP4-to-Annex-B bitstream filter
(`bsf-h264_mp4toannexb`) on top of the base h264+aac+mp3 components.
Drop the resulting `.wasm.wasm` + `.wasm.mjs` into this directory.
