import { MEDIA_MESSAGE } from '@extension/shared';

// "Pick a video on the page" overlay. Activated by a runtime message from
// the background (popup button or Alt+Shift+V hotkey). Lets the user hover
// any element to highlight it, then click to send its media URL to Vidsy.
//
// Extraction rules (in order):
//   1. The clicked element if it's <video>, <audio>, or <source>
//   2. A descendant <video>/<audio> inside the clicked element (poster-style cards)
//   3. An ancestor <video>/<audio> (when the user clicked an overlay button)
//   4. The clicked element if it's an <a href="…"> with a recognisable URL
//   5. data-* attributes commonly used by player libraries (video-src, src)
// Returns undefined when nothing usable is found — the picker stays open so
// the user can try clicking somewhere else.

const PICKER_ATTR = 'data-vidsy-picker';
const OVERLAY_Z = 2147483647; // 2^31 - 1 — highest possible z-index
const HIGHLIGHT_PAD = 2;

let active = false;
let overlay: HTMLDivElement | null = null;
let highlight: HTMLDivElement | null = null;
let label: HTMLDivElement | null = null;
let lastTarget: Element | null = null;

const isOverlayElement = (el: Element | null): boolean =>
  !!el && (el === overlay || el === highlight || el === label || !!(el as HTMLElement).closest?.(`[${PICKER_ATTR}]`));

const extractFromVideoOrAudio = (el: HTMLVideoElement | HTMLAudioElement): string | undefined => {
  const candidates = [el.currentSrc, el.src];
  for (const c of candidates) {
    if (c && !c.startsWith('blob:') && /^https?:/.test(c)) return c;
  }
  const source = el.querySelector<HTMLSourceElement>('source[src]');
  if (source && source.src && !source.src.startsWith('blob:') && /^https?:/.test(source.src)) {
    return source.src;
  }
  return undefined;
};

const extractFromElement = (el: Element): string | undefined => {
  // 1. The element itself
  if (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) {
    const u = extractFromVideoOrAudio(el);
    if (u) return u;
  }
  if (el instanceof HTMLSourceElement && el.src && /^https?:/.test(el.src)) {
    return el.src;
  }

  // 2. Descendant <video>/<audio>
  const descendant = el.querySelector?.('video, audio') as HTMLVideoElement | HTMLAudioElement | null;
  if (descendant) {
    const u = extractFromVideoOrAudio(descendant);
    if (u) return u;
  }

  // 3. Ancestor <video>/<audio>
  const ancestor = el.closest?.('video, audio') as HTMLVideoElement | HTMLAudioElement | null;
  if (ancestor) {
    const u = extractFromVideoOrAudio(ancestor);
    if (u) return u;
  }

  // 4. <a href="…">
  if (el instanceof HTMLAnchorElement && el.href && /^https?:/.test(el.href)) {
    return el.href;
  }
  const anchor = el.closest?.('a[href]') as HTMLAnchorElement | null;
  if (anchor && anchor.href && /^https?:/.test(anchor.href)) {
    return anchor.href;
  }

  // 5. data-* attributes
  if (el instanceof HTMLElement) {
    for (const attr of ['data-video-src', 'data-src', 'data-video-url', 'data-mp4', 'data-hls']) {
      const v = el.getAttribute(attr);
      if (v && /^https?:/.test(v)) return v;
    }
  }

  return undefined;
};

const createOverlay = () => {
  overlay = document.createElement('div');
  overlay.setAttribute(PICKER_ATTR, '1');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: ${OVERLAY_Z};
    background: rgba(0, 0, 0, 0.05); cursor: crosshair;
    pointer-events: none;
  `;

  // A tiny floating banner at the top — explains how to cancel
  const banner = document.createElement('div');
  banner.setAttribute(PICKER_ATTR, '1');
  banner.style.cssText = `
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
    padding: 8px 16px; border-radius: 999px;
    background: rgba(15, 17, 23, 0.92); color: #fff;
    font: 600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    pointer-events: none; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    backdrop-filter: blur(8px);
  `;
  banner.textContent = 'Click a video to download — press Esc to cancel';
  overlay.appendChild(banner);

  // The highlight rectangle that tracks the hovered element
  highlight = document.createElement('div');
  highlight.setAttribute(PICKER_ATTR, '1');
  highlight.style.cssText = `
    position: fixed; pointer-events: none;
    border: 2px solid #3b82f6;
    background: rgba(59, 130, 246, 0.12);
    border-radius: 4px;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.4), 0 4px 12px rgba(59, 130, 246, 0.4);
    transition: all 60ms ease-out;
    display: none;
  `;
  overlay.appendChild(highlight);

  // The label that names what's under the cursor
  label = document.createElement('div');
  label.setAttribute(PICKER_ATTR, '1');
  label.style.cssText = `
    position: fixed; pointer-events: none;
    padding: 3px 8px; border-radius: 4px;
    background: #3b82f6; color: #fff;
    font: 600 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    white-space: nowrap; display: none;
    box-shadow: 0 2px 6px rgba(0,0,0,0.2);
  `;
  overlay.appendChild(label);

  document.documentElement.appendChild(overlay);
};

const updateHighlight = (el: Element) => {
  if (!highlight || !label) return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    highlight.style.display = 'none';
    label.style.display = 'none';
    return;
  }
  highlight.style.display = 'block';
  highlight.style.left = `${rect.left - HIGHLIGHT_PAD}px`;
  highlight.style.top = `${rect.top - HIGHLIGHT_PAD}px`;
  highlight.style.width = `${rect.width + HIGHLIGHT_PAD * 2}px`;
  highlight.style.height = `${rect.height + HIGHLIGHT_PAD * 2}px`;

  const tag = el.tagName.toLowerCase();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  label.textContent = `${tag} · ${w}×${h}`;
  label.style.display = 'block';
  // Place label above the highlight when possible, else inside the top-left
  const labelTop = rect.top - 24;
  label.style.left = `${rect.left}px`;
  label.style.top = `${labelTop < 4 ? rect.top + 4 : labelTop}px`;
};

const onMouseMove = (e: MouseEvent) => {
  if (!active) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || isOverlayElement(el)) return;
  if (el === lastTarget) return;
  lastTarget = el;
  updateHighlight(el);
};

const onClick = (e: MouseEvent) => {
  if (!active) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || isOverlayElement(el)) return;
  e.preventDefault();
  e.stopPropagation();

  const url = extractFromElement(el);
  if (!url) {
    flashFeedback('No media URL on this element — try clicking the video');
    return;
  }
  chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.PICKER_PICKED, payload: { url } }).catch(() => undefined);
  deactivate();
};

const onKeyDown = (e: KeyboardEvent) => {
  if (!active) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    deactivate();
  }
};

const flashFeedback = (text: string) => {
  if (!overlay) return;
  const toast = document.createElement('div');
  toast.setAttribute(PICKER_ATTR, '1');
  toast.style.cssText = `
    position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
    padding: 8px 14px; border-radius: 8px;
    background: rgba(220, 38, 38, 0.94); color: #fff;
    font: 500 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    pointer-events: none; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  `;
  toast.textContent = text;
  overlay.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
};

const activate = () => {
  if (active) return;
  active = true;
  createOverlay();
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
};

const deactivate = () => {
  active = false;
  lastTarget = null;
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  overlay?.remove();
  overlay = null;
  highlight = null;
  label = null;
};

export const initPicker = () => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MEDIA_MESSAGE.PICKER_ACTIVATE) {
      activate();
      sendResponse({ ok: true });
      return false;
    }
    return undefined;
  });
};
