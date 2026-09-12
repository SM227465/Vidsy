import { parseM3u8Attributes } from './media-utils';
import type { MediaVariant } from '@extension/shared';

type ManifestParseResult = {
  variants: MediaVariant[];
  isDrmProtected: boolean;
  // True for a live DASH MPD (type="dynamic"). HLS liveness is probed separately.
  isLive?: boolean;
};

// HLS `METHOD=AES-128` is standard HTTP-delivered envelope encryption — the
// segment fetcher decrypts it. Anything else (SAMPLE-AES, SAMPLE-AES-CTR,
// proprietary schemes with KEYFORMAT pointing at Widevine / PlayReady /
// FairPlay / a uuid:) needs a key we can't obtain — treat as DRM.
const isHlsKeyLineDrm = (attrsRaw: string): boolean => {
  const attrs = parseM3u8Attributes(attrsRaw);
  const method = (attrs.METHOD ?? '').toUpperCase();
  return method !== 'NONE' && method !== '' && method !== 'AES-128';
};

export const parseHlsVariants = async (manifestUrl: string): Promise<ManifestParseResult> => {
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) return { variants: [], isDrmProtected: false };
    const text = await res.text();
    const lines = text.split('\n');
    // Variants that carry no RESOLUTION (rare: audio-only renditions) keep their
    // direct URL since there is no height to select by; everything else is
    // deduped per height in byHeight.
    const variants: MediaVariant[] = [];
    const byHeight = new Map<number, MediaVariant>();
    let isDrmProtected = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) {
        if (isHlsKeyLineDrm(line.slice(line.indexOf(':') + 1))) isDrmProtected = true;
        continue;
      }

      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
      const attrsRaw = line.slice(line.indexOf(':') + 1);
      const attrs = parseM3u8Attributes(attrsRaw);

      const nextLine = lines[i + 1]?.trim();
      if (!nextLine || nextLine.startsWith('#')) continue;
      const variantUrl = new URL(nextLine, manifestUrl).toString();
      const resolutionText = attrs['RESOLUTION'] ?? '';
      const [wStr, hStr] = resolutionText.split('x');
      const width = Number(wStr);
      const height = Number(hStr);
      const bandwidth = attrs['BANDWIDTH'] ? Number(attrs['BANDWIDTH']) : undefined;
      const name = attrs['NAME'] ?? undefined;
      const codecs = attrs['CODECS'] ?? undefined;

      const hasRes = Number.isFinite(width) && Number.isFinite(height);
      const variant: MediaVariant = {
        // Point at the MASTER plus the chosen height (the DASH `mpd#h=` pattern)
        // rather than at the variant playlist. #EXT-X-MEDIA audio groups exist
        // ONLY in the master, so handing the downloader a bare variant URL loses
        // the audio rendition and silently produces a video-only file.
        url: hasRes ? `${manifestUrl}#h=${height}` : variantUrl,
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : undefined,
        resolution: hasRes ? { width, height } : undefined,
        name,
        codecs,
      };

      if (!hasRes) {
        variants.push(variant);
        continue;
      }
      // Masters routinely list the same resolution several times (Reddit ships
      // each twice, differing only in BANDWIDTH), which would show the user 8
      // rows for 4 real choices. Keep one entry per height — the richest one.
      const existing = byHeight.get(height);
      if (!existing || (variant.bandwidth ?? 0) > (existing.bandwidth ?? 0)) byHeight.set(height, variant);
    }

    const allVariants = [...variants, ...byHeight.values()];

    if (isDrmProtected) {
      for (const v of allVariants) v.isDrmProtected = true;
    }

    return { variants: allVariants, isDrmProtected };
  } catch (error) {
    console.debug('parseHlsVariants failed', error);
    return { variants: [], isDrmProtected: false };
  }
};

export const parseDashVariants = async (manifestUrl: string): Promise<ManifestParseResult> => {
  try {
    // credentials:'include' so cookie-gated MPDs resolve; the SW's host
    // permissions bypass CORS, and signed MPD URLs (e.g. VK's ?expires=…&srcIp=…)
    // self-authorize without a Referer.
    const res = await fetch(manifestUrl, { credentials: 'include' });
    if (!res.ok) return { variants: [], isDrmProtected: false };
    const xml = await res.text();

    // The background is a service worker — no DOMParser — so the MPD is parsed
    // with regex. Any ContentProtection element means EME-gated keys we can't
    // obtain (even the generic CENC marker), so the download would be corrupt.
    const isDrmProtected = /<ContentProtection\b[^>]*\bschemeIdUri=/i.test(xml);
    // A live stream (vs VOD) — drives Record instead of Download in the UI.
    const isLive = /<MPD\b[^>]*\btype\s*=\s*["']?dynamic/i.test(xml);

    const attrOf = (tag: string, name: string): string | undefined => {
      const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
      return m ? m[1] : undefined;
    };

    // One selectable entry per VIDEO resolution. Each points back at the MPD with
    // an `#h=<height>` marker that the DASH downloader reads to pick that exact
    // Representation (and still muxes the separate audio track). Reps without a
    // height are audio-only and skipped; duplicate heights keep the highest
    // bitrate (e.g. when a site ships both AV1 and VP9 at 1080p).
    const byHeight = new Map<number, MediaVariant>();
    for (const m of xml.matchAll(/<Representation\b([^>]*)>/gi)) {
      const tag = m[1];
      const height = Number(attrOf(tag, 'height') ?? '0');
      if (!height) continue;
      const width = Number(attrOf(tag, 'width') ?? '0');
      const bwRaw = attrOf(tag, 'bandwidth');
      const bandwidth = bwRaw ? Number(bwRaw) : undefined;
      const existing = byHeight.get(height);
      if (existing && (existing.bandwidth ?? 0) >= (bandwidth ?? 0)) continue;
      byHeight.set(height, {
        url: `${manifestUrl}#h=${height}`,
        name: `${height}p`,
        bandwidth,
        resolution: width ? { width, height } : undefined,
        codecs: attrOf(tag, 'codecs'),
        isDrmProtected: isDrmProtected || undefined,
      });
    }

    return { variants: Array.from(byHeight.values()), isDrmProtected, isLive };
  } catch (error) {
    console.debug('parseDashVariants failed', error);
    return { variants: [], isDrmProtected: false };
  }
};

export type { ManifestParseResult };
