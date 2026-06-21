// Relay a log line to the service-worker console. The offscreen document's own
// console is awkward to open (chrome://extensions → Inspect views → offscreen.html),
// so key download milestones are forwarded to the SW console, which is always at
// hand. Best-effort and never throws — logging must not affect the download.
export const swLog = (msg: string, data?: unknown): void => {
  try {
    void chrome.runtime.sendMessage({ type: 'offscreen/log', payload: { msg, data } }).catch(() => undefined);
  } catch {
    /* ignore */
  }
};
