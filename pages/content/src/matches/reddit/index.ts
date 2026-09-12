import { MEDIA_MESSAGE } from '@extension/shared';

// Reddit title relay.
//
// Reddit video (v.redd.it) is found by the generic HLS network sniffer, so this
// script extracts no URLs — it exists only to NAME what the sniffer finds.
// Without it every item is called "Reddit" (the bare tab title) and files land
// as Reddit.mp4, Reddit (1).mp4, …
//
// The feed is the hard case: one tab holds many videos, so a single per-tab
// title hint cannot tell them apart. Instead each post is paired with the
// v.redd.it id that appears in ITS media URL, and the background matches the id
// against the URL it detected.
//
// An earlier attempt listened for `play` and walked up to the post. That never
// fired: media events are NOT composed, so they never escape the shadow root of
// Reddit's player custom element.

const TITLE_MAX = 180;
const RESCAN_MS = 1500;

const clean = (raw: string | null | undefined): string | undefined => {
  if (!raw) return undefined;
  const t = raw
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*r\/[A-Za-z0-9_]+\s*$/, '') // permalink "<title> : r/sub"
    .replace(/\s*-\s*Reddit\s*$/i, '')
    .trim();
  if (!t || /^reddit$/i.test(t)) return undefined;
  return t.slice(0, TITLE_MAX);
};

// Reddit's markup churns (old.reddit / shreddit / feed cards), so try several
// shapes rather than betting on one.
const titleOf = (post: Element): string | undefined =>
  clean(post.getAttribute('post-title')) ??
  clean(post.getAttribute('aria-label')) ??
  clean(post.querySelector('[slot="title"]')?.textContent) ??
  clean(post.querySelector('h1, h2, h3')?.textContent);

// The id shows up in whichever of these the post happens to carry: the player's
// src, `content-href`, or the `packaged-media-json` blob. Scanning the post's
// serialized markup catches all of them without guessing which is present.
// The optional backslash covers JSON-escaped URLs ("v.redd.it\/abc"), which is
// how they appear inside the packaged-media-json attribute.
const VREDDIT_ID = /v\.redd\.it(?:\\)?\/([a-z0-9]{8,})/gi;

const idsIn = (html: string): string[] => {
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  VREDDIT_ID.lastIndex = 0;
  while ((m = VREDDIT_ID.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
};

// Serializing every post's outerHTML on each tick would be costly on a long
// feed, so a post is only ever read once — after it yields an id it is skipped.
const resolved = new WeakSet<Element>();
const sent = new Map<string, string>();

// Cheap pre-filter: only posts that actually reference a video are worth
// serializing. Attribute presence and a child selector are both far cheaper
// than outerHTML on a card full of markup.
const looksLikeVideo = (post: Element): boolean =>
  post.hasAttribute('packaged-media-json') ||
  post.getAttribute('post-type') === 'video' ||
  post.querySelector('shreddit-player, shreddit-player-2, video, [src*="v.redd.it"]') !== null;

const scan = () => {
  const posts = document.querySelectorAll('shreddit-post, article, [data-testid="post-container"]');
  const entries: { match: string; title: string }[] = [];
  for (const post of Array.from(posts)) {
    if (resolved.has(post) || !looksLikeVideo(post)) continue;
    const title = titleOf(post);
    if (!title) continue;
    const ids = idsIn(post.outerHTML);
    if (ids.length > 0) resolved.add(post);
    for (const id of ids) {
      if (sent.get(id) === title) continue;
      sent.set(id, title);
      entries.push({ match: id, title });
    }
  }
  if (entries.length > 0) {
    chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.TITLE_MAP, payload: { entries } }).catch(() => undefined);
  }

  // A permalink has exactly one video, and its document.title already carries
  // the post name — relay it as the per-tab fallback for anything unmatched.
  if (/\/comments\//.test(location.pathname)) {
    const t = clean(document.querySelector('shreddit-post')?.getAttribute('post-title')) ?? clean(document.title);
    if (t && sent.get('__page') !== t) {
      sent.set('__page', t);
      chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.TITLE_HINT, payload: { title: t } }).catch(() => undefined);
    }
  }
};

// Scan up front, then poll: Reddit lazily hydrates posts and swaps the player in
// after the card renders, so the id often is not in the DOM on first paint. The
// interval also covers SPA navigation without watching history.
scan();
setInterval(scan, RESCAN_MS);
