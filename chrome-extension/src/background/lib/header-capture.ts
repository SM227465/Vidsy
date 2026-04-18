import { dlLog } from './logger';

const capturedRequestHeaders = new Map<string, { timestamp: number; headers: Record<string, string> }>();

const filterCapturedHeaders = (headers: chrome.webRequest.HttpHeader[]) => {
  // Capture all critical anti-bot / CDN validation headers
  const allowed = [
    /^Referer$/i,
    /^Cookie$/i,
    /^Origin$/i,
    /^Authorization$/i,
    /^Sec-Fetch-/i,
    /^User-Agent$/i,
    /^Accept$/i,
    /^Accept-Language$/i,
  ];
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.name && h.value && allowed.some(regex => regex.test(h.name))) {
      out[h.name] = h.value;
    }
  }
  return out;
};

const setupHeaderCapture = () => {
  chrome.webRequest.onSendHeaders.addListener(
    details => {
      if (!details.requestHeaders || details.initiator?.startsWith('chrome-extension://')) return;
      const headers = filterCapturedHeaders(details.requestHeaders);
      if (Object.keys(headers).length > 0) {
        capturedRequestHeaders.set(details.url, { timestamp: Date.now(), headers });
      }
    },
    { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
    ['requestHeaders', 'extraHeaders'],
  );
};

// ─── Dynamic header injection via declarativeNetRequest ───
// fetch() cannot set forbidden headers (Origin, Referer). We use declarativeNetRequest
// to inject them at the network level for CDN requests made by the offscreen document.

let nextDnrRuleId = 1000;
const activeDnrRules = new Map<string, number[]>();

const injectHeadersForDownload = async (cdnUrl: string, headers: Record<string, string>, downloadKey: string) => {
  try {
    const hostname = new URL(cdnUrl).hostname;
    const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];

    for (const [name, value] of Object.entries(headers)) {
      requestHeaders.push({
        header: name,
        operation: chrome.declarativeNetRequest.HeaderOperation.SET,
        value,
      });
    }

    if (requestHeaders.length === 0) return;

    const ruleId = nextDnrRuleId++;
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders,
          },
          condition: {
            requestDomains: [hostname],
            // Omit resourceTypes so it catches sub_frame, media, xmlhttprequest, etc.
          },
        },
      ],
      removeRuleIds: [ruleId],
    });

    activeDnrRules.set(downloadKey, [ruleId]);
    dlLog('injectHeadersForDownload: added DNR rule', { ruleId, hostname, headers });
  } catch (err) {
    dlLog('injectHeadersForDownload: failed', err);
  }
};

const removeHeadersForDownload = async (downloadKey: string) => {
  const ruleIds = activeDnrRules.get(downloadKey);
  if (!ruleIds?.length) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [],
      removeRuleIds: ruleIds,
    });
    dlLog('removeHeadersForDownload: removed DNR rules', { ruleIds });
  } catch (err) {
    dlLog('removeHeadersForDownload: failed', err);
  }
  activeDnrRules.delete(downloadKey);
};

const cleanupStaleDnrRules = () => {
  chrome.declarativeNetRequest.getDynamicRules().then(rules => {
    const staleIds = rules.filter(r => r.id >= 1000).map(r => r.id);
    if (staleIds.length > 0) {
      chrome.declarativeNetRequest.updateDynamicRules({ addRules: [], removeRuleIds: staleIds });
    }
  });
};

export {
  capturedRequestHeaders,
  setupHeaderCapture,
  injectHeadersForDownload,
  removeHeadersForDownload,
  cleanupStaleDnrRules,
};
