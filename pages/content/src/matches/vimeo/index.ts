import { MEDIA_MESSAGE } from '@extension/shared';
import { createBridge, onFromMain, sendToMain } from '@src/lib/broadcast-bridge';

const sentUrls = new Set<string>();

const sendCandidate = (candidate: {
  url: string;
  kind: 'video' | 'audio' | 'hls' | 'dash';
  mimeType?: string;
  title?: string;
  resolution?: { width: number; height: number };
  contentLength?: number;
}) => {
  if (!candidate.url || sentUrls.has(candidate.url)) return;
  sentUrls.add(candidate.url);

  chrome.runtime
    .sendMessage({
      type: MEDIA_MESSAGE.DETECTED,
      payload: {
        url: candidate.url,
        mimeType: candidate.mimeType,
        kind: candidate.kind,
        source: 'element' as const,
        title: candidate.title ?? document.title,
      },
    })
    .catch(() => undefined);
};

type VimeoFile = {
  url?: string;
  quality?: string;
  type?: string;
  width?: number;
  height?: number;
};

type VimeoHls = {
  url?: string;
  default_cdn?: string;
  cdns?: Record<string, { url?: string }>;
};

type VimeoDash = {
  url?: string;
  default_cdn?: string;
  cdns?: Record<string, { url?: string }>;
};

type VimeoConfig = {
  video?: {
    title?: string;
  };
  request?: {
    files?: {
      progressive?: VimeoFile[];
      hls?: VimeoHls;
      dash?: VimeoDash;
    };
  };
};

const extractFromConfig = (config: VimeoConfig) => {
  const title = config.video?.title ?? document.title.replace(/\s*on Vimeo$/, '');
  const files = config.request?.files;
  if (!files) return;

  // Progressive (direct download) formats
  if (files.progressive) {
    for (const file of files.progressive) {
      if (!file.url) continue;
      sendCandidate({
        url: file.url,
        kind: 'video',
        mimeType: file.type,
        title: file.quality ? `${title} [${file.quality}]` : title,
        resolution: file.width && file.height ? { width: file.width, height: file.height } : undefined,
      });
    }
  }

  // HLS master playlist
  if (files.hls) {
    const hlsUrl = files.hls.url ?? files.hls.cdns?.[files.hls.default_cdn ?? '']?.url;
    if (hlsUrl) {
      sendCandidate({
        url: hlsUrl,
        kind: 'hls',
        mimeType: 'application/vnd.apple.mpegurl',
        title: `${title} [HLS]`,
      });
    }
  }

  // DASH manifest
  if (files.dash) {
    const dashUrl = files.dash.url ?? files.dash.cdns?.[files.dash.default_cdn ?? '']?.url;
    if (dashUrl) {
      sendCandidate({
        url: dashUrl,
        kind: 'dash',
        mimeType: 'application/dash+xml',
        title: `${title} [DASH]`,
      });
    }
  }
};

const tryExtractFromScripts = () => {
  const scripts = Array.from(document.querySelectorAll('script'));
  for (const script of scripts) {
    const text = script.textContent ?? '';

    // Vimeo embeds player config in various formats
    const configMatch = text.match(/(?:playerConfig|vimeo\.config)\s*=\s*(\{.+?\});/s);
    if (configMatch?.[1]) {
      try {
        extractFromConfig(JSON.parse(configMatch[1]));
        return;
      } catch {
        continue;
      }
    }
  }
};

const tryExtractFromApiResponse = async () => {
  // For standard vimeo.com/VIDEO_ID pages, try the oEmbed-style config endpoint
  const videoIdMatch = location.pathname.match(/^\/(\d+)/);
  if (!videoIdMatch) return;

  try {
    const res = await fetch(`${location.origin}/video/${videoIdMatch[1]}/config`, {
      credentials: 'include',
    });
    if (!res.ok) return;
    const config = await res.json();
    extractFromConfig(config);
  } catch {
    // config endpoint may not be available
  }
};

const tryExtract = async () => {
  tryExtractFromScripts();
  // If scripts didn't yield results, try the API
  if (sentUrls.size === 0) {
    await tryExtractFromApiResponse();
  }
};

// BroadcastChannel bridge to receive playerConfig from MAIN world
const bridge = createBridge(window.location.href);
onFromMain(bridge, msg => {
  if (msg.name === 'vimeo_on_config' && msg.data) {
    extractFromConfig((msg.data as { config: VimeoConfig }).config);
  }
});
sendToMain(bridge, { name: 'vimeo_request_config', data: null });

// Initial extraction
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => void tryExtract(), 2000));
} else {
  setTimeout(() => void tryExtract(), 2000);
}

// Vimeo uses pushState navigation
let lastUrl = location.href;
const checkNavigation = () => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    sentUrls.clear();
    setTimeout(() => void tryExtract(), 2000);
  }
};

const navObserver = new MutationObserver(checkNavigation);
navObserver.observe(document.documentElement, { childList: true, subtree: true });

console.log('[Media Finder] Vimeo extractor loaded');
