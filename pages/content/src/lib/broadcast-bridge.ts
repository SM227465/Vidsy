/**
 * BroadcastChannel bridge for MAIN ↔ ISOLATED world communication.
 * Must NOT use any chrome.* APIs (MAIN world scripts cannot access them).
 */

type BridgeMessage = {
  name: string;
  data: unknown;
};

type BridgeEnvelope = {
  msg: BridgeMessage;
  direction: 'to-isolated' | 'to-main';
};

/** Fast string hash (cyrb53) — deterministic, no crypto dependency. */
const cyrb53 = (str: string, seed = 0): number => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

export const createChannelName = (pageUrl: string): string => `injected-${cyrb53(pageUrl)}`;

export const createBridge = (pageUrl: string) => new BroadcastChannel(createChannelName(pageUrl));

export const sendToIsolated = (channel: BroadcastChannel, msg: BridgeMessage) => {
  channel.postMessage({ msg, direction: 'to-isolated' } satisfies BridgeEnvelope);
};

export const sendToMain = (channel: BroadcastChannel, msg: BridgeMessage) => {
  channel.postMessage({ msg, direction: 'to-main' } satisfies BridgeEnvelope);
};

export const onFromMain = (channel: BroadcastChannel, handler: (msg: BridgeMessage) => void) => {
  channel.addEventListener('message', (e: MessageEvent<BridgeEnvelope>) => {
    if (e.data?.direction === 'to-isolated') handler(e.data.msg);
  });
};

export const onFromIsolated = (channel: BroadcastChannel, handler: (msg: BridgeMessage) => void) => {
  channel.addEventListener('message', (e: MessageEvent<BridgeEnvelope>) => {
    if (e.data?.direction === 'to-main') handler(e.data.msg);
  });
};

export type { BridgeMessage };
