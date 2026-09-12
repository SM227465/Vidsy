/**
 * Bilibili ISOLATED world script.
 *
 * Receives raw `playurl` / `__playinfo__` payloads relayed from the MAIN world
 * (see ./main.ts), parses the DASH (separate video + audio fMP4 streams) or
 * legacy durl (single-file MP4) representations, and emits a DETECTED candidate.
 *
 * Bilibili DASH baseUrls are whole-file fMP4 streams served over byte-range, so
 * the candidate is shaped for the background's "merged A/V" download path: a
 * video URL plus a paired `audioUrl`. The offscreen pipeline fetches both and
 * muxes them with libav `-c copy`. The required `Referer` header is injected by
 * the download pipeline (see background/lib/download.ts).
 */
import { MEDIA_MESSAGE } from '@extension/shared';
import { createBridge, onFromMain, sendToMain } from '@src/lib/broadcast-bridge';
import type { MediaVariant } from '@extension/shared';

// One candidate per video page (pathname). A quality switch re-fires playurl
// with the SAME set of qualities but freshly-signed URLs — we keep the first
// payload (signed URLs stay valid for hours) and skip the redundant re-sends.
const sentPaths = new Set<string>();

type BiliState = {
  videoData?: { title?: string; pic?: string; duration?: number };
  // bilibili.tv keeps episode metadata under different keys; best-effort only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
};
let latestState: BiliState | undefined;

// ─── normalized track shape ───
type Track = {
  url: string;
  bandwidth: number;
  codecs?: string;
  mimeType?: string;
  width?: number;
  height?: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asArray = (v: any): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pickUrl = (rep: any): string | undefined =>
  rep?.baseUrl ?? rep?.base_url ?? rep?.url ?? asArray(rep?.backupUrl ?? rep?.backup_url)[0] ?? undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toVideoTrack = (rep: any): Track | undefined => {
  const url = pickUrl(rep);
  if (!url) return undefined;
  return {
    url,
    bandwidth: Number(rep.bandwidth ?? rep.bandWidth ?? 0),
    codecs: rep.codecs ?? rep.codec,
    mimeType: rep.mimeType ?? rep.mime_type ?? 'video/mp4',
    width: rep.width ? Number(rep.width) : undefined,
    height: rep.height ? Number(rep.height) : undefined,
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toAudioTrack = (rep: any): Track | undefined => {
  const url = pickUrl(rep);
  if (!url) return undefined;
  return {
    url,
    bandwidth: Number(rep.bandwidth ?? rep.bandWidth ?? 0),
    codecs: rep.codecs ?? rep.codec,
    mimeType: rep.mimeType ?? rep.mime_type ?? 'audio/mp4',
  };
};

type ParsedStreams = { videos: Track[]; audios: Track[]; durl?: string };

// Unwrap the various envelopes: { data }, { result }, or the body itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unwrap = (raw: any): any => raw?.data ?? raw?.result ?? raw ?? {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parseStreams = (raw: any): ParsedStreams | null => {
  const data = unwrap(raw);

  // bilibili.com (and most apps): data.dash.{video,audio}
  const dash = data.dash;
  if (dash && (dash.video || dash.audio)) {
    const videos = asArray(dash.video).map(toVideoTrack).filter((t): t is Track => !!t);
    const audios = asArray(dash.audio).map(toAudioTrack).filter((t): t is Track => !!t);
    // Hi-res audio lives in separate buckets — fall back to them only when the
    // standard AAC track is absent (those mux cleanly into MP4 with -c copy).
    if (audios.length === 0) {
      for (const extra of [dash.dolby?.audio, dash.flac?.audio]) {
        asArray(extra)
          .map(toAudioTrack)
          .forEach(t => t && audios.push(t));
      }
    }
    if (videos.length > 0) return { videos, audios };
  }

  // bilibili.tv intl gateway: data.playurl.{video[].video_resource, audio_resource[]}
  const playurl = data.playurl ?? data.play_url;
  if (playurl && (playurl.video || playurl.audio_resource)) {
    const videos = asArray(playurl.video)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((v: any) => toVideoTrack(v.video_resource ?? v))
      .filter((t): t is Track => !!t && !!t.url);
    const audios = asArray(playurl.audio_resource)
      .map(toAudioTrack)
      .filter((t): t is Track => !!t && !!t.url);
    if (videos.length > 0) return { videos, audios };
  }

  // Legacy single-file MP4 (durl). Only the single-part case is a complete
  // file; multi-part durl would need concatenation, so we skip those.
  const durlParts = asArray(data.durl);
  if (durlParts.length === 1) {
    const url = durlParts[0]?.url ?? asArray(durlParts[0]?.backup_url)[0];
    if (url) return { videos: [], audios: [], durl: url };
  }

  return null;
};

const getTitle = (): string => {
  const stateTitle = latestState?.videoData?.title;
  if (stateTitle) return stateTitle;
  const h1 = document.querySelector('h1[title], h1.video-title, .video-title')?.textContent?.trim();
  if (h1) return h1;
  return document.title.replace(/[_\-|]\s*(bilibili|哔哩哔哩).*$/i, '').trim() || document.title;
};

const qualityName = (t: Track): string | undefined => {
  if (t.height) return `${t.height}p`;
  return undefined;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlePlayurl = (raw: any, href: string) => {
  let path: string;
  try {
    path = new URL(href).pathname;
  } catch {
    path = href;
  }
  if (sentPaths.has(path)) return;

  const parsed = parseStreams(raw);
  if (!parsed) return;

  const title = getTitle();
  const duration = latestState?.videoData?.duration;
  const thumbnail = latestState?.videoData?.pic;

  // Legacy single-file MP4 — direct download, no muxing needed.
  if (parsed.durl) {
    sentPaths.add(path);
    chrome.runtime
      .sendMessage({
        type: MEDIA_MESSAGE.DETECTED,
        payload: {
          url: parsed.durl,
          kind: 'video' as const,
          mimeType: 'video/mp4',
          source: 'element' as const,
          title,
          duration,
          thumbnail,
        },
      })
      .catch(() => undefined);
    return;
  }

  const videos = [...parsed.videos].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth,
  );
  const bestAudio = [...parsed.audios].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (videos.length === 0) return;

  const variants: MediaVariant[] = videos.map(v => ({
    url: v.url,
    name: qualityName(v),
    bandwidth: v.bandwidth,
    codecs: v.codecs,
    resolution: v.width && v.height ? { width: v.width, height: v.height } : undefined,
    audioUrl: bestAudio?.url,
    audioMimeType: bestAudio?.mimeType,
  }));

  const best = videos[0];
  sentPaths.add(path);
  chrome.runtime
    .sendMessage({
      type: MEDIA_MESSAGE.DETECTED,
      payload: {
        url: best.url,
        kind: 'video' as const,
        mimeType: best.mimeType ?? 'video/mp4',
        source: 'element' as const,
        title,
        duration,
        thumbnail,
        resolution: best.width && best.height ? { width: best.width, height: best.height } : undefined,
        audioUrl: bestAudio?.url,
        audioMimeType: bestAudio?.mimeType,
        // Only expose a quality picker when more than one resolution exists.
        variants: variants.length > 1 ? variants : undefined,
      },
    })
    .catch(() => undefined);
};

// ─── Bilibili live (live.bilibili.com) ───
// Live plays via HTTP-FLV (MSE) in-page, so no m3u8 is exposed to sniff. Ask the
// room API for the HLS (fMP4) variant and surface it as a live HLS item the
// recorder can capture. These are the same endpoints the page calls, so a
// credentialed content-script fetch is CORS-allowed.
/* eslint-disable @typescript-eslint/no-explicit-any */
const pickLiveHlsUrl = (streams: any[]): string | undefined => {
  const hls = streams.find(s => typeof s?.protocol_name === 'string' && /hls/i.test(s.protocol_name));
  const formats: any[] = hls?.format ?? [];
  const fmt =
    formats.find(f => f?.format_name === 'fmp4') ?? formats.find(f => f?.format_name === 'ts') ?? formats[0];
  const codec = fmt?.codec?.[0];
  const info = codec?.url_info?.[0];
  if (!codec?.base_url || !info?.host) return undefined;
  return `${info.host}${codec.base_url}${info.extra ?? ''}`;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const getLiveTitle = (): string => document.title.replace(/[-_|｜].*$/, '').trim() || document.title;

const detectBilibiliLive = async () => {
  const urlId = location.pathname.split('/').filter(Boolean)[0];
  if (!urlId || !/^\d+$/.test(urlId)) return;
  try {
    let roomId = urlId;
    try {
      const initRes = await fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${urlId}`, {
        credentials: 'include',
      });
      const initJson = await initRes.json();
      if (initJson?.data?.room_id) roomId = String(initJson.data.room_id);
    } catch {
      /* short-id resolution failed — try the URL id directly */
    }

    const api =
      `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}` +
      `&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8&dolby=5&panorama=1`;
    const res = await fetch(api, { credentials: 'include' });
    const json = await res.json();
    const streams = json?.data?.playurl_info?.playurl?.stream;
    if (!Array.isArray(streams)) return; // offline, or response shape changed
    const url = pickLiveHlsUrl(streams);
    if (!url) return;

    chrome.runtime
      .sendMessage({
        type: MEDIA_MESSAGE.DETECTED,
        payload: {
          url,
          kind: 'hls' as const,
          isLive: true,
          mimeType: 'application/vnd.apple.mpegurl',
          source: 'element' as const,
          title: getLiveTitle(),
        },
      })
      .catch(() => undefined);
  } catch {
    /* not live / API change — ignore */
  }
};

// ─── entry ───
if (location.hostname === 'live.bilibili.com') {
  void detectBilibiliLive();
  // Re-detect when navigating between rooms (live is an SPA).
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      void detectBilibiliLive();
    }
  }, 2000);
} else {
  // VOD: relay playurl / __playinfo__ from the MAIN world over the bridge.
  // Channel key must match main.ts — origin+pathname, stable across the
  // query-string rewrites bilibili does after load.
  const bridge = createBridge(window.location.origin + window.location.pathname);
  onFromMain(bridge, msg => {
    if (msg.name === 'bili_state') {
      const data = msg.data as { state?: BiliState };
      if (data?.state) latestState = data.state;
    } else if (msg.name === 'bili_playurl') {
      const data = msg.data as { raw: unknown; href: string };
      if (data?.raw) handlePlayurl(data.raw, data.href ?? location.href);
    }
  });
  // MAIN ran at document_start and may have relayed the SSR globals before this
  // ISOLATED script existed — ask it to re-send.
  sendToMain(bridge, { name: 'bili_request_initial', data: null });
}

console.log('[Media Finder] Bilibili extractor loaded');
