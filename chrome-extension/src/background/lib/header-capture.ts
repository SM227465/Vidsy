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
// Per-download header set + the domains already covered by a rule, so the
// offscreen side can ask for additional hosts once it has parsed the manifest
// (segments / AES keys / init often live on a different CDN host than the
// playlist the rule was originally scoped to).
const activeDnrHeaders = new Map<string, Record<string, string>>();
const activeDnrDomains = new Map<string, Set<string>>();

const toModifyHeaderInfos = (headers: Record<string, string>): chrome.declarativeNetRequest.ModifyHeaderInfo[] =>
  Object.entries(headers).map(([name, value]) => ({
    header: name,
    operation: chrome.declarativeNetRequest.HeaderOperation.SET,
    value,
  }));

const addHeaderRule = async (domains: string[], headers: Record<string, string>): Promise<number> => {
  const ruleId = nextDnrRuleId++;
  // Must be a SESSION rule: the `tabIds` condition is only valid for
  // session-scoped rules (updateDynamicRules rejects it). Session rules live in
  // memory and are cleared on browser restart, which is exactly right for these
  // transient per-download header rewrites.
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: toModifyHeaderInfos(headers),
        },
        condition: {
          requestDomains: domains,
          // tabIds: [-1] scopes the rewrite to extension-originated requests
          // (offscreen doc, service worker). Without this, the Referer/Origin
          // rewrite leaks into normal browsing on any open tab that hits the
          // same CDN hostname.
          tabIds: [-1],
          // Omit resourceTypes so it catches sub_frame, media, xmlhttprequest, etc.
        },
      },
    ],
    removeRuleIds: [ruleId],
  });
  return ruleId;
};

const injectHeadersForDownload = async (cdnUrl: string, headers: Record<string, string>, downloadKey: string) => {
  try {
    if (Object.keys(headers).length === 0) return;
    const hostname = new URL(cdnUrl).hostname;
    const ruleId = await addHeaderRule([hostname], headers);
    activeDnrRules.set(downloadKey, [ruleId]);
    activeDnrHeaders.set(downloadKey, headers);
    activeDnrDomains.set(downloadKey, new Set([hostname]));
    dlLog('injectHeadersForDownload: added DNR rule', { ruleId, hostname, headers });
  } catch (err) {
    dlLog('injectHeadersForDownload: failed', err);
  }
};

// Called from the offscreen document (via 'media/extend-dnr') after it parses
// the manifest and learns which hosts the segment fetches will actually hit.
const extendHeadersForDownload = async (downloadKey: string, hostnames: string[]) => {
  try {
    const headers = activeDnrHeaders.get(downloadKey);
    if (!headers) return; // no header rule active for this download
    const covered = activeDnrDomains.get(downloadKey) ?? new Set<string>();
    const fresh = [...new Set(hostnames)].filter(h => !!h && !covered.has(h));
    if (fresh.length === 0) return;
    const ruleId = await addHeaderRule(fresh, headers);
    fresh.forEach(h => covered.add(h));
    activeDnrDomains.set(downloadKey, covered);
    activeDnrRules.set(downloadKey, [...(activeDnrRules.get(downloadKey) ?? []), ruleId]);
    dlLog('extendHeadersForDownload: added DNR rule', { ruleId, fresh });
  } catch (err) {
    dlLog('extendHeadersForDownload: failed', err);
  }
};

const removeHeadersForDownload = async (downloadKey: string) => {
  const ruleIds = activeDnrRules.get(downloadKey);
  activeDnrRules.delete(downloadKey);
  activeDnrHeaders.delete(downloadKey);
  activeDnrDomains.delete(downloadKey);
  if (!ruleIds?.length) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [],
      removeRuleIds: ruleIds,
    });
    dlLog('removeHeadersForDownload: removed DNR rules', { ruleIds });
  } catch (err) {
    dlLog('removeHeadersForDownload: failed', err);
  }
};

const cleanupStaleDnrRules = () => {
  // Header rules are session-scoped now; sweep leftovers from a prior session.
  chrome.declarativeNetRequest.getSessionRules().then(rules => {
    const staleIds = rules.filter(r => r.id >= 1000).map(r => r.id);
    if (staleIds.length > 0) {
      chrome.declarativeNetRequest.updateSessionRules({ addRules: [], removeRuleIds: staleIds });
    }
  });
  // Also clear any header rules an older build left in the dynamic (persistent) store.
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
  extendHeadersForDownload,
  removeHeadersForDownload,
  cleanupStaleDnrRules,
};
