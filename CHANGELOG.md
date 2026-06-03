# Changelog

All notable user-facing changes to Vidsy. Dates are in UTC.

## 1.1.0 — 2026-06-03

### Added
- **Browser download interceptor** *(opt-in, on by default)* — catches browser-initiated video / audio downloads via `chrome.downloads.onCreated`, cancels the native flow, and offers a "Download File Info" modal with Start Download / Open in Browser / Cancel. Filename is editable in the modal; large opaque-host downloads (file-host hash URLs with `application/octet-stream` MIME and no extension in URL or filename) are recognized via a 50 MB size heuristic.
- **Standalone progress window** — one per intercepted download, opened as a chrome-less popup window that survives main-browser minimize. Shows filename, source host, status, file size, downloaded / %, transfer rate, time left, resume capability, big progress bar, and a collapsible per-connection breakdown.
- **Live per-connection breakdown** — position bar splits each in-flight HTTP Range chunk into a faint extent + a vivid foreground that fills as bytes arrive; active-connections table shows live `downloaded / chunk size` per slot. Table padded to a stable 8-row floor so the accordion height stays steady as slots cycle.
- **Byte-level resume for HTTP Range downloads** *(in-session)* — pause preserves the OPFS file and chunk-completion state; resume skips chunks already on disk and continues with only the missing ones. Workers write each chunk at its byte offset (`opfs.writeAt`) so chunks can complete out of order without head-of-line blocking. Validates the OPFS file isn't empty before trusting resume state; falls back cleanly to a full restart across browser restarts (offscreen-doc startup GC purges OPFS).
- **Resume / Retry button on the standalone window** — paused / failed / cancelled stages show a Resume (paused) or Retry (failed/cancelled) button alongside Close, mirroring the browser-action popup's DownloadRow.
- **User-tunable Connections per file setting** — Options → Preferences, range 1-16, default 8. Controls parallel HTTP Range requests for a single download.
- **Auto-close on complete** — opt-in checkbox on the Complete view; window self-closes 3 seconds after the download succeeds.
- **One-time save-as flash hint** — yellow banner in the intercept modal pointing at `chrome://settings/downloads` → "Ask where to save each file" so users can disable Chrome's native save-as flash. Dismisses forever.
- **System theme on first run** — extension UI defaults to your OS `prefers-color-scheme` instead of always starting in light mode; manual toggle still wins after that.

### Changed
- **Honest progress labels** — status flips to "Connecting…" after 5s of no bytes during a download stage, "Stalled — waiting for server…" after 30s; transfer rate decays to "—" after 3s of stale data. Pause path no longer zeros `downloadedBytes`, so the progress bar holds where you paused.
- **Pause / Resume semantics** — pause aborts the download but keeps the OPFS scratch file and chunk-completion state in storage so the next start can resume; cancel clears both.
- **Mux % progress for stream-copy** falls back to `opfs.size(outputOpfsName)` when the bundled libav build doesn't expose `ffmpeg_get_out_time_ms`. MP3 transcode stays indeterminate (output size diverges from input).
- Worker dispatch concurrency cap bumped from 6 to 8 and made tunable via the new Connections-per-file setting.

### Fixed
- White-strip flash on the right of the standalone window during first paint — CSS variables on `:root` are now overridden via an inline `<script>` in `popup/index.html` so the body never paints at the browser-action popup's 380 px width.
- Offscreen module-load regression that broke the `runtime.onMessage` listener registration (and silently killed every download with "Receiving end does not exist") — `@extension/storage` is now dynamically imported inside `worker-client.ts` so its top-level `createStorage` calls can't poison the offscreen entry's load path.

## 1.0.9 — 2026-05-29

### Fixed
- **Chrome Web Store policy compliance — YouTube content** — content scripts now declare `exclude_matches` for `youtube.com`, `youtube-nocookie.com`, and `googlevideo.com` so the extension does not inject on those hosts. `handleDownload` refuses any URL on a restricted host as defense-in-depth, and the context menu no-ops when the page, source, or link is on a restricted host. Addresses Blue Zinc rejection of v1.0.7.

## 1.0.8 — 2026-05-28

### Fixed
- **Chrome Web Store branding-policy compliance** — Korean locale name was leftover boilerplate ("크롬 익스텐션 보일러플레이트" = "Chrome Extension Boilerplate"), which violated the rule against using "Chrome" in an extension name. Korean name is now "Vidsy" with a proper description. English description tightened to a specific functional summary instead of the generic "Download Videos from Website".
- README purged remaining references to features that were removed for content-policy compliance.

## 1.0.7 — 2026-05-27

### Removed
- YouTube site-specific media-extractor content script and host blocklist entries — required to keep the extension listed on the Chrome Web Store after a content-policy hit on 1.0.6.

## 1.0.6 — 2026-05-26

### Added
- Sprint 9 hardening: declarativeNetRequest rule scoping (`tabIds: [-1]` so the Referer/Origin rewrite only matches extension-originated requests), OPFS startup garbage collection (purges orphaned scratch files left by crashes or browser kills), DRM parser tightening (HLS flags any METHOD other than NONE/empty/AES-128; DASH flags any `<ContentProtection>` element including generic-CENC-only).

## Earlier releases

Pre-1.0.6 releases (Sprints 5-8 — libav.js swap + OPFS streaming, paste-URL + QR share, element picker, serial download queue + concurrency setting + queue reorder polish) are documented in the commit history and the per-sprint memory files under `~/.claude/projects/.../memory/`.
