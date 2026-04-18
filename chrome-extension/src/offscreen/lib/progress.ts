import type { MediaDownloadProgress } from '@extension/shared';

export const updateProgress = async (key: string, prog: Partial<MediaDownloadProgress>) => {
  await chrome.runtime.sendMessage({ type: 'offscreen/progress', payload: { key, prog } }).catch(() => undefined);
};

export const clearProgress = async (key: string) => {
  await chrome.runtime.sendMessage({ type: 'offscreen/clear', payload: { key } }).catch(() => undefined);
};
