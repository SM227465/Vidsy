import type { HlsKeyInfo } from './m3u8-parser';

const hlsKeyCache = new Map<string, CryptoKey>();

const getHlsDecryptionKey = async (keyUri: string, headers?: Record<string, string>): Promise<CryptoKey> => {
  const cached = hlsKeyCache.get(keyUri);
  if (cached) return cached;

  const res = await fetch(keyUri, {
    headers: Object.fromEntries(
      Object.entries(headers || {}).filter(([k]) => !['Origin', 'Referer', 'Cookie'].includes(k)),
    ),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to fetch HLS key: ${res.status}`);
  const keyData = await res.arrayBuffer();
  if (keyData.byteLength !== 16) throw new Error(`Invalid AES-128 key length: ${keyData.byteLength}`);

  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-CBC' }, false, ['decrypt']);
  hlsKeyCache.set(keyUri, cryptoKey);
  return cryptoKey;
};

const defaultIvForSequence = (seq: number): Uint8Array => {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seq);
  return iv;
};

export const decryptSegment = async (
  data: ArrayBuffer,
  keyInfo: HlsKeyInfo,
  seq: number,
  headers?: Record<string, string>,
): Promise<ArrayBuffer> => {
  if (keyInfo.method !== 'AES-128' || !keyInfo.uri) return data;
  const cryptoKey = await getHlsDecryptionKey(keyInfo.uri, headers);
  const iv = keyInfo.iv ?? defaultIvForSequence(seq);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(iv) }, cryptoKey, data);
};
