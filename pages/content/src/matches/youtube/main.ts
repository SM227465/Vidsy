/**
 * YouTube MAIN world script — runs in page context so it can read window globals.
 * Relays ytInitialPlayerResponse (stream URLs) and ytcfg (VISITOR_DATA) to the
 * isolated world via BroadcastChannel.
 * Must NOT use chrome.* APIs.
 */
import { createBridge, onFromIsolated, sendToIsolated } from '@src/lib/broadcast-bridge';

const channel = createBridge(window.location.href);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any;

/* ── Relay VISITOR_DATA ─────────────────────────────── */
const extractVisitorData = () => {
  const visitorData: string | undefined = w.ytcfg?.data_?.VISITOR_DATA;
  if (visitorData) {
    sendToIsolated(channel, { name: 'youtube_on_visitor_data', data: { visitor_data: visitorData } });
  }
};

/* ── Relay ytInitialPlayerResponse ──────────────────── */
const extractAndRelayPlayerResponse = () => {
  const pr = w.ytInitialPlayerResponse;
  if (!pr?.streamingData) return false;
  sendToIsolated(channel, { name: 'youtube_player_response', data: { playerResponse: pr } });
  return true;
};

/* ── Listen for requests from isolated world ─────────── */
onFromIsolated(channel, msg => {
  if (msg.name === 'youtube_request_visitor_data') extractVisitorData();
  if (msg.name === 'youtube_request_player_response') extractAndRelayPlayerResponse();
});

/* ── Initial extraction ──────────────────────────────── */
extractVisitorData();
// ytInitialPlayerResponse may not be set yet at document_start — retry with backoff
if (!extractAndRelayPlayerResponse()) {
  setTimeout(() => {
    if (!extractAndRelayPlayerResponse()) {
      setTimeout(extractAndRelayPlayerResponse, 2000);
    }
  }, 500);
}
