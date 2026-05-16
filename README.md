# Vidsy - Ultimate Video Downloader Extension

Looking for a powerful **video downloader extension** for Chrome? **Vidsy** is a browser extension that seamlessly detects and downloads video and audio from almost any website. Whether it's standard HTTP streams or complex HLS/DASH formats, Vidsy grabs the media and remuxes it into a proper MP4/MP3 utilizing **libav.js (FFmpeg) compiled to WebAssembly**, with OPFS-backed streaming so multi-GB files mux without tab crashes.

> **Note from the Developer:**
> This is my personal attempt at building a Chrome extension capable of detecting and allowing users to download media directly from the web. I know this is not perfect and hasn't been widely tested across all websites. Please feel free to create an issue if you are facing any problems—your suggestions and feedback are extremely welcome and truly matter! If you are a developer, bug fixes and feature pull requests are highly appreciated.

Built on [Chrome Extension Boilerplate with React + Vite + TypeScript](https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite).

## Install

### From Chrome Web Store (recommended)

Install with one click:

**[Vidsy on the Chrome Web Store](https://chromewebstore.google.com/detail/vidsy/kpaipljgcidaeajchdaignokjaggkmfh)**

Works in Chrome, Edge, Brave, and any other Chromium-based browser.

### Manual install (load unpacked)

For early access to fixes or for development testing:

1. Download the latest build zip from the [Releases page](https://github.com/SM227465/Vidsy/releases/latest), or build locally with `pnpm install && pnpm zip` (outputs `dist-zip/`).
2. Unzip the archive somewhere stable (the extension reads files from this directory at runtime — don't delete it after loading).
3. Open `chrome://extensions` in your browser.
4. Toggle **Developer mode** on (top-right corner).
5. Click **Load unpacked** and select the unzipped folder.

## Features

- **Automatic media detection** via network request monitoring (`webRequest` API)
- **HLS/DASH support** with segment downloading, AES-128 decryption, and libav.js remux to MP4
- **Multi-GB downloads** via OPFS (Origin Private File System) streaming — no 2 GB WASM memory cliff
- **MP3 audio extraction** from any source using `libmp3lame` transcoding (quality `-q:a 2`, ~190 kbps VBR)
- **Subtitle / closed-caption download** — detects WebVTT, SRT, TTML, and auto-generated tracks; converts to SRT on save
- **Smart metadata extraction** from JSON-LD, OpenGraph, and meta tags (title, thumbnail, duration)
- **CDN header injection** via `declarativeNetRequest` for sites requiring Referer/Origin headers
- **All downloads managed internally** (HTTP, HLS, DASH, merged video+audio) with real-time progress tracking
- **DRM-protected stream detection** — identifies Widevine / PlayReady / FairPlay upfront and refuses cleanly (no silent failures)
- **HTTP Range-parallel downloads** — multi-connection acceleration for plain MP4 sources
- **Merged video + audio downloads** — single libav invocation combines split A/V streams (YouTube, DASH)
- **Main-video filtering** to skip hover previews and tiny player widgets
- **Disk space preflight** — checks `navigator.storage.estimate()` before large jobs to avoid mid-mux disk failures
- **Site-specific detectors** for YouTube and Vimeo with deep metadata extraction
- **Cancel / stop** any in-progress download with OPFS cleanup
- **Dashboard options page** with settings, download history, and about panel
- **Popup + Side Panel** — quick-access UIs with download progress bars and media cards
- **Context menu** — right-click any `<video>` / `<audio>` element to download it
- **Dark / light theme** — respects system preference

## Supported download strategies

| Strategy | Source type | Output | Notes |
|----------|-------------|--------|-------|
| HTTP Range-parallel | Direct MP4 / MP3 URLs | MP4 / MP3 | Multi-connection for speed; no mux needed for MP4 |
| HLS stream-copy | `.m3u8` playlists (TS or fMP4) | MP4 | Native libav HLS demuxer; AES-128 handled |
| HLS transcode | `.m3u8` → audio only | MP3 | libmp3lame encode |
| DASH stream-copy | `.mpd` manifests | MP4 | Native libav DASH demuxer |
| Merged V+A | Separate video & audio tracks | MP4 | Single libav pass with two `jsfetch:` inputs |
| Subtitles | WebVTT / SRT / TTML | SRT | Converted on save |

DRM-protected streams (Widevine, PlayReady, FairPlay) are detected pre-dispatch and rejected with a user-visible message — Vidsy does not attempt decryption.

## Architecture

```
┌──────────────┐   ┌──────────────────┐   ┌─────────────────────┐
│  Content     │   │  Service Worker  │   │  Offscreen Document │
│  Scripts     │──▶│  (background)    │──▶│                     │
│              │   │                  │   │   ┌──────────────┐  │
│  - detectors │   │  - dispatch      │   │   │  Dedicated   │  │
│  - metadata  │   │  - DNR rules     │   │   │  Worker      │  │
│  - UI inject │   │  - header cap    │   │   │              │  │
└──────────────┘   │  - downloads API │   │   │  - libav.js  │  │
                   └──────────────────┘   │   │  - OPFS      │  │
                                          │   │  - jsfetch   │  │
                                          │   └──────────────┘  │
                                          └─────────────────────┘
```

- **Content scripts** detect media via DOM inspection + network observation and inject the in-page overlay UI.
- **Service worker** (background) dispatches downloads, manages DNR rules for header rewriting, and talks to the Chrome `downloads` API.
- **Offscreen document** hosts a dedicated Web Worker that runs libav.js (FFmpeg compiled to WASM). All muxing output streams directly to OPFS via `mkwriterdev` + `onwrite(name, pos, buf)` — never touches JS heap, so multi-GB remuxes stay under ~500 MB RAM.

## Setup

### Prerequisites

- Node.js >= 18
- pnpm >= 9
- Chromium-based browser (Chrome 116+, Edge 116+, Brave, etc.)

### Install

```bash
pnpm install
```

### Development

```bash
pnpm dev
```

Load the `dist/` directory as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → **Load unpacked**).

### Production Build

```bash
pnpm build
```

### Package as zip (for Chrome Web Store)

```bash
pnpm zip
```

### Other scripts

```bash
pnpm type-check   # strict TypeScript across all packages
pnpm lint         # ESLint (includes import-x/exports-last)
pnpm clean        # remove dist/, node_modules caches
```

## Project structure

Monorepo managed with pnpm + Turbo:

```
chrome-extension/      MV3 manifest, service worker, offscreen doc, libav worker
pages/
  popup/               Toolbar popup
  side-panel/          Full side-panel UI
  options/             Settings + download history dashboard
  content/             Site-specific detectors (YouTube, Vimeo, generic)
  content-ui/          In-page overlay (download buttons on hover)
  devtools/            Devtools page
packages/
  shared/              Shared types + util helpers (media formatters, etc.)
  ui/                  Reusable React components (MediaCard, DownloadProgress, etc.)
  storage/             chrome.storage wrappers (settings, history, detections)
  i18n/                Localized strings
  tailwindcss-config/  Shared Tailwind config
  tsconfig/            Shared TS config
  vite-config/         Shared Vite config
```

## Browser Permissions

| Permission | Reason |
|------------|--------|
| `webRequest` | Monitor network requests for media detection + header capture |
| `declarativeNetRequest` | Inject CDN headers (Referer, Origin) for downloads |
| `declarativeNetRequestWithHostAccess` | Host-level header rules |
| `storage` | Persist detections, history, settings |
| `scripting` | Extract page metadata (title, thumbnail, duration) |
| `tabs` | Access tab info for media association |
| `downloads` | Save downloaded files to disk |
| `offscreen` | libav.js (FFmpeg WASM) OPFS-streaming mux |
| `contextMenus` | Right-click "Download media" on video/audio elements |
| `sidePanel` | Side panel UI |
| `notifications` | Surface download completion / failure |
| `unlimitedStorage` | OPFS quota for multi-GB video muxing |
| `host_permissions: <all_urls>` | Detect media on any website |

### Required COOP / COEP headers

The extension sets `cross-origin-embedder-policy: require-corp` and `cross-origin-opener-policy: same-origin` in the manifest so WebAssembly + OPFS `FileSystemSyncAccessHandle` works under strict MV3 isolation.

## Licenses

This project bundles a prebuilt **libav.js** WebAssembly binary (FFmpeg + libmp3lame) under **LGPL-2.1**. The full attribution, patent notes (H.264 / MP3), and rebuild instructions are in [`chrome-extension/public/libav/NOTICE.md`](chrome-extension/public/libav/NOTICE.md) and [`chrome-extension/public/libav/LICENSE.LGPL-2.1`](chrome-extension/public/libav/LICENSE.LGPL-2.1).

- **FFmpeg** (libavformat, libavcodec, libavutil, …) — LGPL-2.1-or-later — <https://ffmpeg.org/>
- **libmp3lame** 3.100 — LGPL-2.1-or-later — <https://lame.sourceforge.io/>
- **libav.js** 6.5.7.1 (compile toolchain + JS glue) — 2-Clause BSD / LGPL-2.1 — <https://github.com/Yahweasel/libav.js>

Under LGPL-2.1 you may obtain complete source for the bundled libraries at the URLs above and relink the WebAssembly against a modified version. See `NOTICE.md` for the rebuild recipe.

The extension source itself is released under the terms documented in this repository's `LICENSE` file (or the upstream boilerplate's license where applicable).

## Contributing

Bug reports and PRs are welcome. Before sending a PR:

1. Branch from `main` (or the active feature branch).
2. Run `pnpm type-check && pnpm lint` — both must pass.
3. If you touch the download pipeline, verify against at least one HLS + one DASH + one plain-HTTP source.
4. Keep commits focused; follow the existing commit-message style (`feat(scope): …`, `fix(scope): …`).

Open issues for feature requests or site-compatibility bugs — include the page URL, detection output, and SW console log if possible.

## Feedback

Found a site where Vidsy doesn't detect media? Found a download that fails? Open an issue with reproduction steps — feedback from real-world sites is the most useful thing you can contribute.
