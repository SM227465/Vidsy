import type { MediaKind } from '@extension/shared';

export const createId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export const getPathExtension = (url: string): string => {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').pop() ?? '';
    const dotIdx = lastSegment.lastIndexOf('.');
    return dotIdx >= 0 ? lastSegment.slice(dotIdx).toLowerCase() : '';
  } catch {
    return '';
  }
};

export const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.flv', '.avi', '.ogv', '.m4v', '.3gp', '.wmv']);
export const AUDIO_EXTS = new Set(['.mp3', '.aac', '.wav', '.ogg', '.m4a', '.flac', '.wma', '.opus']);
export const SUBTITLE_EXTS = new Set(['.vtt', '.srt', '.ttml', '.dfxp']);

export const deriveKind = (url: string, mime?: string): MediaKind => {
  const normalizedMime = mime?.toLowerCase() ?? '';
  const ext = getPathExtension(url);

  if (normalizedMime.includes('application/vnd.apple.mpegurl') || normalizedMime.includes('application/x-mpegurl')) {
    return 'hls';
  }
  if (ext === '.m3u8') {
    return 'hls';
  }
  if (normalizedMime.includes('application/dash+xml')) {
    return 'dash';
  }
  if (ext === '.mpd') {
    return 'dash';
  }
  if (
    normalizedMime.startsWith('text/vtt') ||
    normalizedMime.includes('application/ttml+xml') ||
    normalizedMime.includes('application/x-subrip')
  ) {
    return 'subtitle';
  }
  if (SUBTITLE_EXTS.has(ext)) {
    return 'subtitle';
  }
  if (normalizedMime.startsWith('video/')) {
    return 'video';
  }
  if (normalizedMime.startsWith('audio/')) {
    return 'audio';
  }
  if (VIDEO_EXTS.has(ext)) {
    return 'video';
  }
  if (AUDIO_EXTS.has(ext)) {
    return 'audio';
  }

  return 'other';
};

export const MIN_MEDIA_SIZE_BYTES = 10_000; // 10KB — skip tiny tracker/pixel requests

export const isHlsSegment = (url: string, mime?: string) => {
  const ext = getPathExtension(url);
  const lowerMime = mime?.toLowerCase() ?? '';
  if (ext === '.ts') return true;
  if (lowerMime.includes('mp2t')) return true;
  return false;
};

export const isDashSegment = (url: string, mime?: string) => {
  const ext = getPathExtension(url);
  const lowerUrl = url.toLowerCase();
  const lowerMime = mime?.toLowerCase() ?? '';
  if (ext === '.m4s' || ext === '.cmfv' || lowerUrl.includes('/dash/seg') || lowerUrl.includes('range/')) return true;
  if (lowerMime.includes('mp4') && lowerUrl.includes('seg')) return true;
  return false;
};

/** Decode HTML entities (e.g. &lpar; → (, &amp; → &, &period; → .) from page titles.
 *  Runs in service-worker context (no DOM), so uses a comprehensive named-entity map. */
export const htmlDecode = (s: string): string => {
  if (!s.includes('&')) return s;
  // Named entity map — covers all entities commonly found in video site titles
  const NAMED: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    ndash: '\u2013',
    mdash: '\u2014',
    hellip: '\u2026',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    lpar: '(',
    rpar: ')',
    lbrack: '[',
    rbrack: ']',
    lbrace: '{',
    rbrace: '}',
    period: '.',
    comma: ',',
    colon: ':',
    semi: ';',
    excl: '!',
    quest: '?',
    num: '#',
    dollar: '$',
    percnt: '%',
    sol: '/',
    bsol: '\\',
    horbar: '\u2015',
    ast: '*',
    plus: '+',
    equals: '=',
    minus: '-',
    lowbar: '_',
    hat: '^',
    grave: '`',
    tilde: '~',
    vert: '|',
    at: '@',
    copy: '©',
    reg: '®',
    trade: '™',
    deg: '°',
    middot: '·',
    bull: '•',
    prime: '′',
    Prime: '″',
    laquo: '«',
    raquo: '»',
    lsaquo: '‹',
    rsaquo: '›',
    hearts: '♥',
    star: '★',
    check: '✓',
    cross: '✗',
  };
  return s
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => NAMED[name] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
};

export const sanitizeFileName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 180) || 'download';

export const GENERIC_MANIFEST_RE =
  /^(master|index|playlist|manifest|video|media|hls|dash|stream|chunklist)(\.[a-z0-9]+)?$/i;

export const deriveFileName = (url: string, title?: string) => {
  // Prefer a meaningful title over a generic URL path segment
  // HTML-decode any entities that may appear in og:title / document.title
  const cleanTitle = title ? htmlDecode(title.trim()) : undefined;
  if (cleanTitle && cleanTitle.length > 3 && !cleanTitle.match(/^[\w.-]+\.\w{2,}$/)) {
    return sanitizeFileName(cleanTitle);
  }
  try {
    const parsed = new URL(url);
    const lastPart = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    if (lastPart && !GENERIC_MANIFEST_RE.test(lastPart.replace(/\?.*$/, ''))) {
      return lastPart;
    }
  } catch {
    // ignore
  }
  return sanitizeFileName(cleanTitle ?? 'download');
};

export const isHlsKind = (kind?: MediaKind, url?: string) =>
  kind === 'hls' || (url ? url.toLowerCase().endsWith('.m3u8') : false);

export const isDashKind = (kind?: MediaKind, url?: string) =>
  kind === 'dash' || (url ? url.toLowerCase().endsWith('.mpd') : false);

export const documentTitleFromUrl = (pageUrl?: string) => {
  if (!pageUrl) return undefined;
  try {
    const { hostname } = new URL(pageUrl);
    return hostname;
  } catch {
    return undefined;
  }
};

export const parseM3u8Attributes = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    // skip whitespace and commas
    while (i < raw.length && (raw[i] === ',' || raw[i] === ' ')) i++;
    if (i >= raw.length) break;

    const eqIdx = raw.indexOf('=', i);
    if (eqIdx < 0) break;
    const key = raw.slice(i, eqIdx).trim();
    i = eqIdx + 1;

    let value: string;
    if (raw[i] === '"') {
      // quoted value — find closing quote
      const closeIdx = raw.indexOf('"', i + 1);
      if (closeIdx < 0) {
        value = raw.slice(i + 1);
        i = raw.length;
      } else {
        value = raw.slice(i + 1, closeIdx);
        i = closeIdx + 1;
      }
    } else {
      // unquoted value — find next comma
      const commaIdx = raw.indexOf(',', i);
      if (commaIdx < 0) {
        value = raw.slice(i).trim();
        i = raw.length;
      } else {
        value = raw.slice(i, commaIdx).trim();
        i = commaIdx;
      }
    }
    attrs[key] = value;
  }
  return attrs;
};
