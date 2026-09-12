import { registerOutputForCleanup } from './blob-cleanup';
import {
  hlsManifestDurationSeconds,
  jsfetchInputForOpfs,
  jsfetchInputForUrl,
  needsAuthFallback,
  preflightDiskSpace,
} from './libav-mux';
import { parseHlsPlaylist, parseM3u8Attributes } from './m3u8-parser';
import { updateProgress, clearProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import { swLog } from './sw-log';
import { cancelWorkerJob, fetchSegmentsToOpfs, getOpfsFile, muxInWorker, removeOpfs } from './worker-client';

const opfsNameFor = (key: string, tag: string, ext: string): string =>
  `hls-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}-${Date.now().toString(36)}.${ext}`;

// `audioUrl` is set only when the master playlist carries audio as a SEPARATE
// #EXT-X-MEDIA rendition (Reddit's v.redd.it, VK VOD, many CDNs). Those variant
// playlists are video-only, so downloading one alone yields a SILENT file — the
// audio playlist has to be fetched as a second input and muxed in.
type ResolvedPlaylist = { url: string; manifestText: string; audioUrl?: string };

// Parse `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8",DEFAULT=YES` lines
// into group-id → playlist URL. A group can list several renditions (languages);
// prefer DEFAULT=YES, else the first with a URI. Renditions with no URI are
// muxed into the video segments already and need no second input.
const parseAudioRenditions = (manifestText: string, baseUrl: string): Map<string, string> => {
  const byGroup = new Map<string, string>();
  const isDefault = new Set<string>();
  for (const raw of manifestText.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('#EXT-X-MEDIA')) continue;
    const attrs = parseM3u8Attributes(line.slice(line.indexOf(':') + 1));
    if ((attrs['TYPE'] ?? '').toUpperCase() !== 'AUDIO') continue;
    const group = attrs['GROUP-ID'];
    const uri = attrs['URI'];
    if (!group || !uri) continue;
    const preferred = (attrs['DEFAULT'] ?? '').toUpperCase() === 'YES';
    if (!byGroup.has(group) || (preferred && !isDefault.has(group))) {
      try {
        byGroup.set(group, new URL(uri, baseUrl).toString());
        if (preferred) isDefault.add(group);
      } catch {
        /* malformed URI — skip this rendition */
      }
    }
  }
  return byGroup;
};

const resolveVariantPlaylist = async (
  playlistUrl: string,
  signal?: AbortSignal,
  depth = 0,
): Promise<ResolvedPlaylist> => {
  // Master playlists can point at further playlists; a malformed or malicious
  // one pointing back at itself would otherwise recurse forever.
  if (depth > 5) throw new Error('HLS playlist nesting too deep (possible loop)');
  // The resolution picker encodes the chosen height as `<master>#h=<height>`
  // (same convention as DASH's `mpd#h=`), so the master — and therefore its
  // #EXT-X-MEDIA audio group — stays in the chain instead of being bypassed.
  const heightMatch = /[#&]h=(\d+)/.exec(playlistUrl);
  const targetHeight = heightMatch ? Number(heightMatch[1]) : undefined;
  const manifestUrl = playlistUrl.split('#')[0];
  // Bound the manifest fetch — without a timeout a CDN that accepts the
  // connection but never responds stalls the whole download at 0 bytes with no
  // error (it just hangs here forever).
  const timeoutSignal = AbortSignal.timeout(20_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(manifestUrl, { credentials: 'include', signal: combinedSignal });
  if (!res.ok) throw new Error(`Failed to fetch HLS playlist: ${res.status}`);
  const manifestText = await res.text();
  // SAMPLE-AES / FairPlay / PlayReady / Widevine = DRM. Plain AES-128 is fine — libav handles it.
  if (
    /METHOD=SAMPLE-AES|URI="skd:\/\/|KEYFORMAT="(?:com\.apple\.streamingkeydelivery|com\.microsoft\.playready|com\.widevine\.alpha|urn:uuid:)/i.test(
      manifestText,
    )
  ) {
    throw new Error('This video is DRM-protected and cannot be downloaded.');
  }
  if (!manifestText.includes('#EXT-X-STREAM-INF')) return { url: manifestUrl, manifestText };

  const lines = manifestText.split('\n').map(l => l.trim());
  const audioByGroup = parseAudioRenditions(manifestText, manifestUrl);
  let bestBandwidth = -1;
  let bestUrl = '';
  let bestAudioGroup: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const bwMatch = line.match(/BANDWIDTH=(\d+)/);
    const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
    // When a height was requested, only consider streams of that height — the
    // highest-bandwidth one among them. Falling back to "best overall" when the
    // height is absent keeps old detections (bare variant URLs) working.
    if (targetHeight !== undefined) {
      const resMatch = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
      if (!resMatch || Number(resMatch[2]) !== targetHeight) continue;
    }
    let j = i + 1;
    while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) j++;
    if (j < lines.length && bw > bestBandwidth) {
      bestBandwidth = bw;
      bestUrl = new URL(lines[j], manifestUrl).toString();
      bestAudioGroup = parseM3u8Attributes(line.slice(line.indexOf(':') + 1))['AUDIO'];
    }
  }
  // The requested height may be missing (playlist changed since detection) —
  // retry without the constraint rather than failing the download.
  if (!bestUrl && targetHeight !== undefined) {
    return resolveVariantPlaylist(manifestUrl, signal, depth);
  }
  if (!bestUrl) throw new Error('No variant stream found in master playlist');
  // The audio rendition lives in THIS master, so resolve it before recursing —
  // the nested call only ever sees the (video-only) variant playlist.
  const audioUrl = bestAudioGroup ? audioByGroup.get(bestAudioGroup) : undefined;
  const resolved = await resolveVariantPlaylist(bestUrl, signal, depth + 1);
  return { ...resolved, audioUrl: resolved.audioUrl ?? audioUrl };
};

// When the sniffer hands us a MEDIA playlist (e.g. Reddit's HLS_720.m3u8) rather
// than the master, the audio rendition is invisible: #EXT-X-MEDIA only ever
// appears in the master. That silently yields a video-only file. So probe the
// usual master filenames alongside it and, if one actually lists this playlist,
// take the audio group from there.
//
// Bounded on purpose: a handful of HEAD-ish GETs with a short timeout, every
// failure ignored. Worst case we learn nothing and download video-only as before.
const MASTER_CANDIDATES = ['HLSPlaylist.m3u8', 'master.m3u8', 'index.m3u8', 'playlist.m3u8'];

const findSiblingAudioRendition = async (
  mediaPlaylistUrl: string,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  let base: URL;
  try {
    base = new URL(mediaPlaylistUrl);
  } catch {
    return undefined;
  }
  const selfName = base.pathname.split('/').pop() ?? '';
  for (const candidate of MASTER_CANDIDATES) {
    if (candidate === selfName) continue;
    const masterUrl = new URL(candidate + base.search, base).toString();
    try {
      const timeout = AbortSignal.timeout(8_000);
      const res = await fetch(masterUrl, {
        credentials: 'include',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.includes('#EXT-X-STREAM-INF')) continue;
      // Only trust a master that actually references the playlist we are
      // downloading — otherwise we could pair audio from an unrelated stream.
      if (selfName && !text.includes(selfName)) continue;
      const audioByGroup = parseAudioRenditions(text, masterUrl);
      if (audioByGroup.size === 0) continue;
      // Prefer the group declared on the STREAM-INF line that points at us.
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
        const group = parseM3u8Attributes(line.slice(line.indexOf(':') + 1))['AUDIO'];
        if (group && audioByGroup.has(group)) return audioByGroup.get(group);
      }
      return audioByGroup.values().next().value;
    } catch {
      /* candidate missing or blocked — try the next */
    }
  }
  return undefined;
};

const mp4StreamCopyArgs = (input: string, output: string): string[] => ['-i', input, '-c', 'copy', '-y', output];

const hlsMp4StreamCopyArgs = (jsfetchUrl: string, output: string): string[] => [
  '-f',
  'hls',
  '-i',
  jsfetchUrl,
  '-c',
  'copy',
  '-y',
  output,
];

// Separate video + audio inputs (HLS #EXT-X-MEDIA audio rendition). `0:v:0` /
// `1:a:0` pin the streams explicitly so libav can't pick the wrong one, and the
// `?` on audio keeps the mux from failing outright if the rendition turned out
// to hold no usable audio stream.
const mp4TwoInputCopyArgs = (videoInput: string, audioInput: string, output: string): string[] => [
  '-i',
  videoInput,
  '-i',
  audioInput,
  '-map',
  '0:v:0',
  '-map',
  '1:a:0?',
  '-c',
  'copy',
  '-shortest',
  '-y',
  output,
];

const hlsTwoInputCopyArgs = (videoJsfetch: string, audioJsfetch: string, output: string): string[] => [
  '-f',
  'hls',
  '-i',
  videoJsfetch,
  '-f',
  'hls',
  '-i',
  audioJsfetch,
  '-map',
  '0:v:0',
  '-map',
  '1:a:0?',
  '-c',
  'copy',
  '-shortest',
  '-y',
  output,
];

const mp3TranscodeArgs = (input: string, output: string): string[] => [
  '-i',
  input,
  '-vn',
  '-c:a',
  'libmp3lame',
  '-q:a',
  '2',
  '-y',
  output,
];

const hlsMp3TranscodeArgs = (jsfetchUrl: string, output: string): string[] => [
  '-f',
  'hls',
  '-i',
  jsfetchUrl,
  '-vn',
  '-c:a',
  'libmp3lame',
  '-q:a',
  '2',
  '-y',
  output,
];

const downloadHlsMuxed = async (
  playlistUrl: string,
  fileName: string,
  output: 'mp4' | 'mp3',
  key: string,
  headers?: Record<string, string>,
): Promise<{ blobUrl: string; ext: string }> => {
  void fileName;
  // Register the abort controller BEFORE any network I/O — a cancel that
  // lands during the manifest fetch must abort it, not no-op. The fetch
  // itself runs inside the try so any failure still hits the finally below
  // and clears the registration.
  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const useAuthFallback = needsAuthFallback(headers);
  const ext = output === 'mp3' ? '.mp3' : '.mp4';
  const outputOpfsName = opfsNameFor(key, 'out', output);
  let inputOpfsName: string | null = null;
  let inputBlobUrl: string | null = null;
  // Second accumulator, used only when the master carries a separate audio
  // rendition and we're on the auth-fallback path (segments pre-fetched to OPFS).
  let audioOpfsName: string | null = null;
  let audioBlobUrl: string | null = null;

  try {
    swLog('HLS: start', { key, useAuthFallback });
    await updateProgress(key, { stage: 'fetch-manifest', downloadedBytes: 0 });
    const {
      url: variantUrl,
      manifestText,
      audioUrl: masterAudioUrl,
    } = await resolveVariantPlaylist(playlistUrl, abortController.signal);
    // No audio group in the master — or we were never given a master. Probe for
    // a sibling master before accepting a silent, video-only download.
    const audioUrl =
      masterAudioUrl ?? (await findSiblingAudioRendition(variantUrl, abortController.signal).catch(() => undefined));
    const durationSeconds = hlsManifestDurationSeconds(manifestText);
    swLog('HLS: manifest resolved', {
      variantUrl,
      durationSeconds,
      audioUrl,
      // true = the sniffer handed us a MEDIA playlist, not a master, so the
      // audio group (if any) could only come from the sibling-master probe.
      handedMediaPlaylist: variantUrl === playlistUrl.split('#')[0],
      audioFrom: masterAudioUrl ? 'master' : audioUrl ? 'sibling-probe' : 'none',
      bytes: manifestText.length,
    });

    if (!useAuthFallback) {
      // Direct: libav demuxes HLS natively and writes the MP4/MP3 to OPFS.
      const jsfetchUrl = jsfetchInputForUrl(variantUrl);
      // For mp3 the audio rendition IS the source — transcode it directly and
      // skip the (video-only) variant entirely.
      const audioJsfetch = audioUrl ? jsfetchInputForUrl(audioUrl) : null;
      const args =
        output === 'mp3'
          ? hlsMp3TranscodeArgs(audioJsfetch ?? jsfetchUrl, outputOpfsName)
          : audioJsfetch
            ? hlsTwoInputCopyArgs(jsfetchUrl, audioJsfetch, outputOpfsName)
            : hlsMp4StreamCopyArgs(jsfetchUrl, outputOpfsName);
      await muxInWorker({ jobKey: key, outputOpfsName, ffmpegArgs: args, durationSeconds });
    } else {
      // Auth-fallback: pre-fetch segments into OPFS so DNR-rewritten auth
      // headers reach the CDN, then feed libav an OPFS-backed blob URL.
      const { segments, mapUrl, mapByteRange } = parseHlsPlaylist(manifestText, variantUrl);
      swLog('HLS: parsed playlist', { segments: segments.length, isFmp4: Boolean(mapUrl), mapUrl });
      if (segments.length === 0) throw new Error('No segments in HLS playlist');
      const isFmp4 = Boolean(mapUrl);
      inputOpfsName = opfsNameFor(key, 'in', isFmp4 ? 'mp4' : 'ts');

      // Separate audio rendition: pull its playlist too, so we can fetch both
      // tracks and mux. Without this the output is silent.
      let audioSegments: ReturnType<typeof parseHlsPlaylist> | null = null;
      if (audioUrl) {
        const audioPlaylist = await resolveVariantPlaylist(audioUrl, abortController.signal);
        audioSegments = parseHlsPlaylist(audioPlaylist.manifestText, audioPlaylist.url);
        if (audioSegments.segments.length === 0) {
          swLog('HLS: audio rendition empty — continuing video-only');
          audioSegments = null;
        } else {
          audioOpfsName = opfsNameFor(key, 'in-audio', audioSegments.mapUrl ? 'mp4' : 'ts');
        }
      }

      // Segments / AES keys / init often live on a different CDN host than
      // the playlist — widen the SW's DNR header rule before fetching.
      const extraHosts = new Set<string>();
      const addHost = (u?: string) => {
        if (!u) return;
        try {
          extraHosts.add(new URL(u).hostname);
        } catch {
          /* relative or malformed — already resolved elsewhere */
        }
      };
      segments.forEach(s => {
        addHost(s.url);
        addHost(s.keyInfo?.uri);
      });
      addHost(mapUrl);
      audioSegments?.segments.forEach(seg => {
        addHost(seg.url);
        addHost(seg.keyInfo?.uri);
      });
      addHost(audioSegments?.mapUrl);
      await chrome.runtime
        .sendMessage({ type: 'media/extend-dnr', payload: { key, hostnames: [...extraHosts] } })
        .catch(() => undefined);
      swLog('HLS: extend-dnr sent, fetching segments…', { hosts: [...extraHosts] });

      const { totalBytes } = await fetchSegmentsToOpfs({
        jobKey: key,
        opfsName: inputOpfsName,
        segments: segments.map(s => ({
          url: s.url,
          keyInfo: s.keyInfo,
          sequenceNumber: s.sequenceNumber,
          byteRange: s.byteRange,
        })),
        initUrl: mapUrl,
        initByteRange: mapByteRange,
        keyHeaders: headers,
        stage: 'download-video',
      });
      swLog('HLS: segments fetched', { totalBytes });

      let audioBytes = 0;
      if (audioSegments && audioOpfsName) {
        const audioRes = await fetchSegmentsToOpfs({
          jobKey: key,
          opfsName: audioOpfsName,
          segments: audioSegments.segments.map(seg => ({
            url: seg.url,
            keyInfo: seg.keyInfo,
            sequenceNumber: seg.sequenceNumber,
            byteRange: seg.byteRange,
          })),
          initUrl: audioSegments.mapUrl,
          initByteRange: audioSegments.mapByteRange,
          keyHeaders: headers,
          stage: 'download-audio',
        });
        audioBytes = audioRes.totalBytes;
        swLog('HLS: audio segments fetched', { audioBytes });
      }

      // The concat shortcut only produces a correct file when the fMP4 segments
      // already carry audio — with a separate rendition we must go through libav.
      if (output !== 'mp3' && isFmp4 && !audioOpfsName) {
        // init + fMP4 segments concatenated IS a valid MP4 — skip libav entirely.
        const file = await getOpfsFile(inputOpfsName);
        const blobUrl = URL.createObjectURL(file);
        registerOutputForCleanup(blobUrl, inputOpfsName);
        inputOpfsName = null; // hand-off: do not remove on cleanup
        await clearProgress(key);
        return { blobUrl, ext: '.mp4' };
      }

      // Need room for the output (≈ totalBytes for stream-copy MP4,
      // noticeably less for MP3 but still nonzero). Fail cleanly up front.
      await preflightDiskSpace(totalBytes + audioBytes);

      const { jsfetchUrl, blobUrl } = await jsfetchInputForOpfs(inputOpfsName);
      inputBlobUrl = blobUrl;
      let audioJsfetch: string | null = null;
      if (audioOpfsName) {
        const a = await jsfetchInputForOpfs(audioOpfsName);
        audioJsfetch = a.jsfetchUrl;
        audioBlobUrl = a.blobUrl;
      }

      const args =
        output === 'mp3'
          ? mp3TranscodeArgs(audioJsfetch ?? jsfetchUrl, outputOpfsName)
          : audioJsfetch
            ? mp4TwoInputCopyArgs(jsfetchUrl, audioJsfetch, outputOpfsName)
            : mp4StreamCopyArgs(jsfetchUrl, outputOpfsName);
      await muxInWorker({
        jobKey: key,
        outputOpfsName,
        ffmpegArgs: args,
        durationSeconds,
        estimatedBytes: output === 'mp3' ? undefined : totalBytes + audioBytes,
      });

      URL.revokeObjectURL(inputBlobUrl);
      inputBlobUrl = null;
      void removeOpfs(inputOpfsName).catch(() => undefined);
      inputOpfsName = null;
      if (audioBlobUrl) {
        URL.revokeObjectURL(audioBlobUrl);
        audioBlobUrl = null;
      }
      if (audioOpfsName) {
        void removeOpfs(audioOpfsName).catch(() => undefined);
        audioOpfsName = null;
      }
    }

    const outputFile = await getOpfsFile(outputOpfsName);
    const blobUrl = URL.createObjectURL(outputFile);
    registerOutputForCleanup(blobUrl, outputOpfsName);
    await clearProgress(key);
    return { blobUrl, ext };
  } catch (err) {
    if (inputBlobUrl) {
      try {
        URL.revokeObjectURL(inputBlobUrl);
      } catch {
        /* ignore */
      }
    }
    if (audioBlobUrl) {
      try {
        URL.revokeObjectURL(audioBlobUrl);
      } catch {
        /* ignore */
      }
    }
    if (inputOpfsName) void removeOpfs(inputOpfsName).catch(() => undefined);
    if (audioOpfsName) void removeOpfs(audioOpfsName).catch(() => undefined);
    void removeOpfs(outputOpfsName).catch(() => undefined);
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};

export { resolveVariantPlaylist, mp4StreamCopyArgs, mp3TranscodeArgs, downloadHlsMuxed };
