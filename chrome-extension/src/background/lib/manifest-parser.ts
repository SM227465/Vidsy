import { parseM3u8Attributes } from './media-utils';
import type { MediaVariant } from '@extension/shared';

export type ManifestParseResult = {
  variants: MediaVariant[];
  isDrmProtected: boolean;
};

// HLS `METHOD=AES-128` is standard HTTP-delivered AES — not DRM, the segment fetcher
// already handles it. SAMPLE-AES/SAMPLE-AES-CTR paired with a proprietary KEYFORMAT
// (Widevine / PlayReady / FairPlay) is the DRM case we cannot decrypt.
const DRM_KEY_FORMATS = [
  'com.apple.streamingkeydelivery', // FairPlay
  'com.widevine.alpha',
  'com.microsoft.playready',
  'urn:uuid:', // any proprietary DRM UUID scheme
];

const isHlsKeyLineDrm = (attrsRaw: string): boolean => {
  const attrs = parseM3u8Attributes(attrsRaw);
  const method = (attrs.METHOD ?? '').toUpperCase();
  if (method === 'NONE' || method === '' || method === 'AES-128') return false;
  if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') return true;
  const keyFormat = (attrs.KEYFORMAT ?? '').toLowerCase();
  return DRM_KEY_FORMATS.some(fmt => keyFormat.includes(fmt));
};

export const parseHlsVariants = async (manifestUrl: string): Promise<ManifestParseResult> => {
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) return { variants: [], isDrmProtected: false };
    const text = await res.text();
    const lines = text.split('\n');
    const variants: MediaVariant[] = [];
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

      variants.push({
        url: variantUrl,
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : undefined,
        resolution: Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined,
        name,
        codecs,
      });
    }

    if (isDrmProtected) {
      for (const v of variants) v.isDrmProtected = true;
    }

    return { variants, isDrmProtected };
  } catch (error) {
    console.debug('parseHlsVariants failed', error);
    return { variants: [], isDrmProtected: false };
  }
};

export const parseDashVariants = async (manifestUrl: string): Promise<ManifestParseResult> => {
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) return { variants: [], isDrmProtected: false };
    const xml = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');

    // Any ContentProtection element with a non-generic schemeIdUri means DRM.
    // The generic CENC marker (urn:mpeg:dash:mp4protection:2011) by itself only
    // says "AES-CTR encrypted" — DRM requires a key system UUID alongside it.
    const GENERIC_CENC = 'urn:mpeg:dash:mp4protection:2011';
    const contentProtections = Array.from(doc.querySelectorAll('ContentProtection'));
    const isDrmProtected = contentProtections.some(el => {
      const scheme = (el.getAttribute('schemeIdUri') ?? '').toLowerCase();
      if (!scheme) return false;
      return scheme !== GENERIC_CENC;
    });

    const reps = Array.from(doc.querySelectorAll('Representation'));
    const variants = reps
      .map(rep => {
        const bandwidth = rep.getAttribute('bandwidth');
        const width = rep.getAttribute('width');
        const height = rep.getAttribute('height');
        const codecs = rep.getAttribute('codecs') ?? undefined;
        const baseUrl = rep.querySelector('BaseURL')?.textContent?.trim();
        if (!baseUrl) return undefined;
        const absoluteUrl = new URL(baseUrl, manifestUrl).toString();
        return {
          url: absoluteUrl,
          bandwidth: bandwidth ? Number(bandwidth) : undefined,
          resolution: width && height ? { width: Number(width), height: Number(height) } : undefined,
          codecs,
          name: rep.getAttribute('id') ?? undefined,
          isDrmProtected: isDrmProtected || undefined,
        } as MediaVariant;
      })
      .filter((v): v is MediaVariant => Boolean(v));

    return { variants, isDrmProtected };
  } catch (error) {
    console.debug('parseDashVariants failed', error);
    return { variants: [], isDrmProtected: false };
  }
};
