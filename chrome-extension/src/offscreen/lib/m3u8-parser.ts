export type HlsKeyInfo = {
  method: 'AES-128' | 'NONE';
  uri?: string;
  iv?: Uint8Array;
};

// Inclusive byte range within `url`. Set when the playlist uses
// #EXT-X-BYTERANGE, i.e. every "segment" is a slice of ONE big file rather than
// its own resource. Ignoring it makes each segment fetch the WHOLE file — which
// is how a 2:50 Reddit video came out as 1.6 GB of the same 36 MB repeated 44x.
export type HlsByteRange = { start: number; end: number };

export type HlsSegmentInfo = {
  url: string;
  keyInfo?: HlsKeyInfo;
  sequenceNumber: number;
  byteRange?: HlsByteRange;
};

export type HlsPlaylistResult = {
  segments: HlsSegmentInfo[];
  mapUrl?: string;
  // Byte range for the #EXT-X-MAP init segment, when it too is a slice.
  mapByteRange?: HlsByteRange;
  // Live-stream signals. A media playlist is "live" when it carries NO
  // #EXT-X-ENDLIST and is not an explicit VOD: the server keeps appending
  // (EVENT) or sliding a window of (no PLAYLIST-TYPE) new segments, so a
  // recorder must re-fetch the playlist on an interval to discover them.
  endList: boolean;
  playlistType?: 'VOD' | 'EVENT';
  // #EXT-X-TARGETDURATION (seconds). Per RFC 8216 §6.3.4 a live playlist is
  // reloaded no faster than this (and half of it after an unchanged poll) —
  // the live recorder uses it to pace polling.
  targetDuration?: number;
  // First segment's media sequence number (#EXT-X-MEDIA-SEQUENCE). The recorder
  // dedupes across polls by sequenceNumber, so it needs this to know where the
  // current window starts.
  mediaSequence: number;
};

// A media playlist is live when the server has not signalled the end of the
// stream and has not declared it a finished VOD asset. Both EVENT (append-only)
// and window-sliding (no PLAYLIST-TYPE) playlists count as live.
export const isLivePlaylist = (result: Pick<HlsPlaylistResult, 'endList' | 'playlistType'>): boolean =>
  !result.endList && result.playlistType !== 'VOD';

export const parseM3u8Attributes = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && (raw[i] === ',' || raw[i] === ' ')) i++;
    if (i >= raw.length) break;
    const eqIdx = raw.indexOf('=', i);
    if (eqIdx < 0) break;
    const key = raw.slice(i, eqIdx).trim();
    i = eqIdx + 1;
    let value: string;
    if (raw[i] === '"') {
      const closeIdx = raw.indexOf('"', i + 1);
      if (closeIdx < 0) {
        value = raw.slice(i + 1);
        i = raw.length;
      } else {
        value = raw.slice(i + 1, closeIdx);
        i = closeIdx + 1;
      }
    } else {
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

export const parseHlsPlaylist = (manifestText: string, baseUrl: string): HlsPlaylistResult => {
  const lines = manifestText.split('\n').map(l => l.trim());
  const segments: HlsSegmentInfo[] = [];
  let currentKey: HlsKeyInfo | undefined;
  let mediaSequence = 0;
  let segIndex = 0;
  let mapUrl: string | undefined;
  let mapByteRange: HlsByteRange | undefined;
  // #EXT-X-BYTERANGE applies to the NEXT URL line. An absent offset means
  // "immediately after the previous range of the same resource" (RFC 8216
  // §4.3.2.2), so the last end has to be carried per-URL.
  let pendingRange: HlsByteRange | undefined;
  const lastEndByUrl = new Map<string, number>();
  let endList = false;
  let playlistType: 'VOD' | 'EVENT' | undefined;
  let targetDuration: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
    }

    if (line === '#EXT-X-ENDLIST') {
      endList = true;
    }

    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      const t = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase();
      if (t === 'VOD' || t === 'EVENT') playlistType = t;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const d = parseInt(line.slice('#EXT-X-TARGETDURATION:'.length), 10);
      if (Number.isFinite(d) && d > 0) targetDuration = d;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseM3u8Attributes(line.slice('#EXT-X-MAP:'.length));
      if (attrs['URI']) {
        mapUrl = new URL(attrs['URI'], baseUrl).toString();
        const br = attrs['BYTERANGE'];
        if (br) {
          const [lenStr, offStr] = br.split('@');
          const len = parseInt(lenStr, 10);
          const off = offStr !== undefined ? parseInt(offStr, 10) : 0;
          if (Number.isFinite(len) && len > 0 && Number.isFinite(off)) {
            mapByteRange = { start: off, end: off + len - 1 };
            lastEndByUrl.set(mapUrl, mapByteRange.end);
          }
        }
      }
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      // "<length>[@<offset>]" — applies to the next URL line.
      const [lenStr, offStr] = line.slice('#EXT-X-BYTERANGE:'.length).trim().split('@');
      const len = parseInt(lenStr, 10);
      if (Number.isFinite(len) && len > 0) {
        const off = offStr !== undefined ? parseInt(offStr, 10) : undefined;
        pendingRange = { start: off ?? -1, end: len }; // resolved at the URL line
      }
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseM3u8Attributes(line.slice('#EXT-X-KEY:'.length));
      const method = attrs['METHOD']?.toUpperCase();
      if (method === 'NONE') {
        currentKey = { method: 'NONE' };
      } else if (method === 'AES-128') {
        const uri = attrs['URI'];
        let iv: Uint8Array | undefined;
        if (attrs['IV']) {
          const hex = attrs['IV'].replace(/^0x/i, '');
          iv = new Uint8Array(hex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
        }
        currentKey = { method: 'AES-128', uri: uri ? new URL(uri, baseUrl).toString() : undefined, iv };
      }
    }

    if (line && !line.startsWith('#')) {
      const url = new URL(line, baseUrl).toString();
      let byteRange: HlsByteRange | undefined;
      if (pendingRange) {
        // pendingRange carries {start: offset ?? -1, end: length} until now,
        // because a missing offset can only be resolved against this URL.
        const length = pendingRange.end;
        const start = pendingRange.start >= 0 ? pendingRange.start : (lastEndByUrl.get(url) ?? -1) + 1;
        byteRange = { start, end: start + length - 1 };
        lastEndByUrl.set(url, byteRange.end);
        pendingRange = undefined;
      }
      segments.push({
        url,
        keyInfo: currentKey?.method === 'AES-128' ? { ...currentKey } : undefined,
        sequenceNumber: mediaSequence + segIndex,
        byteRange,
      });
      segIndex++;
    }
  }

  return { segments, mapUrl, mapByteRange, endList, playlistType, targetDuration, mediaSequence };
};
