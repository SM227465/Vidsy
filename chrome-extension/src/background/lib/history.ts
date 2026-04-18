import { DEFAULT_MEDIA_SETTINGS } from '@extension/shared';
import { mediaHistoryStorage, mediaSettingsStorage } from '@extension/storage';
import type { MediaHistoryItem, MediaItem } from '@extension/shared';

const trimHistory = (history: MediaHistoryItem[], max: number) => history.slice(0, Math.max(0, max));

export const addHistoryEntry = async (
  item: MediaItem,
  status: MediaHistoryItem['status'],
  failureReason?: string,
  downloadId?: number,
) => {
  const settings = await mediaSettingsStorage.get();
  const maxHistory = settings?.maxHistory ?? DEFAULT_MEDIA_SETTINGS.maxHistory;
  const current = await mediaHistoryStorage.get();
  const nextEntry: MediaHistoryItem = {
    ...item,
    downloadedAt: Date.now(),
    status,
    failureReason,
    downloadId,
  };
  const nextHistory = trimHistory([nextEntry, ...current], maxHistory);
  await mediaHistoryStorage.set(nextHistory);
};
