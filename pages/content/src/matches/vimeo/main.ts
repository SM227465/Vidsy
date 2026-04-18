/**
 * Vimeo MAIN world script — polls window.playerConfig and relays to ISOLATED world.
 * Must NOT use chrome.* APIs.
 */
import { createBridge, onFromIsolated, sendToIsolated } from '@src/lib/broadcast-bridge';

const channel = createBridge(window.location.href);

const pollPlayerConfig = () => {
  let delay = 1000;
  const maxDelay = 8000;
  let attempts = 0;
  const maxAttempts = 10;

  const check = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const config = w.playerConfig ?? w.vimeo?.config;
    if (config) {
      sendToIsolated(channel, { name: 'vimeo_on_config', data: { config } });
      return;
    }
    attempts++;
    if (attempts >= maxAttempts) return;
    delay = Math.min(delay * 2, maxDelay);
    setTimeout(check, delay);
  };

  setTimeout(check, delay);
};

onFromIsolated(channel, msg => {
  if (msg.name === 'vimeo_request_config') {
    pollPlayerConfig();
  }
});

pollPlayerConfig();
