import { MEDIA_MESSAGE, useStorage, pickBestVariant } from '@extension/shared';
import type { DownloadState } from '@extension/shared';
import {
  mediaDetectionsStorage,
  mediaDownloadsStorage,
  mediaHistoryStorage,
  mediaSettingsStorage,
  exampleThemeStorage,
} from '@extension/storage';
import { useEffect, useMemo, useState } from 'react';
import type {
  MediaDetectionState,
  MediaDownloadProgress,
  MediaHistoryItem,
  MediaItem,
  MediaSettings,
} from '@extension/shared';

export const useMediaPage = () => {
  const detections = useStorage(mediaDetectionsStorage) as MediaDetectionState;
  const history = (useStorage(mediaHistoryStorage) ?? []) as MediaHistoryItem[];
  const settings = useStorage(mediaSettingsStorage) as MediaSettings;
  const downloads = (useStorage(mediaDownloadsStorage) ?? {}) as Record<string, MediaDownloadProgress>;
  const { isLight } = useStorage(exampleThemeStorage);

  const [tabId, setTabId] = useState<number | null>(null);
  const [downloadState, setDownloadState] = useState<DownloadState>({ busyUrl: null, error: null });
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const [view, setView] = useState<'main' | 'settings' | 'history' | 'downloads'>('main');
  const [moreMenuId, setMoreMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      setTabId(tab?.id ?? null);
    });
  }, []);

  const currentMedia = useMemo(() => {
    if (!tabId || !detections) return [] as MediaItem[];
    return detections[String(tabId)] ?? [];
  }, [tabId, detections]);

  const isLoading = tabId === null;

  useEffect(() => {
    const next: Record<string, string> = {};
    currentMedia.forEach(item => {
      if (item.variants && item.variants.length > 0) {
        const best = pickBestVariant(item.variants);
        if (best) next[item.id] = best.url;
      }
    });
    setSelectedVariants(prev => ({ ...next, ...prev }));
  }, [currentMedia]);

  useEffect(() => {
    if (downloadState.busyUrl) return;
    const ACTIVE = new Set(['init', 'fetch-manifest', 'download-video', 'download-audio', 'mux', 'finalize']);
    const entry = Object.entries(downloads).find(([, p]) => ACTIVE.has(p.stage));
    if (entry) setDownloadState({ busyUrl: entry[0], error: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloads]);

  const onDownload = async (item: MediaItem, outputFormat?: 'mp4' | 'mp3') => {
    setMoreMenuId(null);
    setDownloadState({ busyUrl: item.url, error: null });
    const chosenVariant =
      item.variants && item.variants.length > 0
        ? item.variants.find(v => v.url === selectedVariants[item.id]) ?? item.variants[0]
        : undefined;
    let chosenUrl = chosenVariant?.url ?? item.url;
    // Audio pairing for YouTube adaptive formats: prefer variant-level, fall back to item-level.
    let audioUrl: string | undefined;
    let audioMimeType: string | undefined;
    if (outputFormat === 'mp3') {
      // For MP3 output, skip the video track entirely — fetch only the audio URL
      // (paired audio for video-only items, or the item itself if already audio)
      // and let the offscreen pipeline transcode it.
      const audioOnly = chosenVariant?.audioUrl ?? item.audioUrl;
      if (audioOnly) chosenUrl = audioOnly;
    } else {
      audioUrl = chosenVariant?.audioUrl ?? item.audioUrl;
      audioMimeType = chosenVariant?.audioMimeType ?? item.audioMimeType;
    }
    const response = await chrome.runtime.sendMessage({
      type: MEDIA_MESSAGE.DOWNLOAD,
      payload: {
        url: chosenUrl,
        key: item.url,
        kind: item.kind,
        fileName: item.fileName,
        title: item.title,
        tabId: tabId ?? undefined,
        outputFormat,
        audioUrl,
        audioMimeType,
        item,
      },
    });
    if (!response?.ok) {
      setDownloadState({ busyUrl: null, error: response?.error ?? 'Download failed' });
    } else {
      setDownloadState({ busyUrl: null, error: null });
    }
  };

  const onCancel = async (url: string) => {
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CANCEL, payload: { url, intent: 'cancel' } });
    setDownloadState({ busyUrl: null, error: null });
  };

  const onPause = async (url: string) => {
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CANCEL, payload: { url, intent: 'pause' } });
    setDownloadState({ busyUrl: null, error: null });
  };

  const onRetry = async (entry: MediaDownloadProgress) => {
    if (!entry.item) return;
    await onDownload(entry.item, entry.outputFormat);
  };

  const onClearDownloads = async (keys?: string[]) => {
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CLEAR_DOWNLOADS, payload: { keys } });
  };

  const clearTabDetections = () => {
    if (!tabId) return;
    chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CLEAR_TAB, payload: { tabId } }).catch(() => undefined);
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).catch(() => undefined);
    setMoreMenuId(null);
  };

  const startEdit = (item: MediaItem) => {
    setEditingId(item.id);
    setEditName(item.fileName ?? item.url);
  };

  const toggleHlsMerge = () =>
    mediaSettingsStorage.set(prev => ({ ...prev, enableHlsMerging: !prev.enableHlsMerging }));

  const clearHistory = () => mediaHistoryStorage.set([]);

  // Theme classes
  const bg = isLight ? 'bg-white' : 'bg-[#0f1117]';
  const text = isLight ? 'text-gray-900' : 'text-gray-100';
  const textMuted = isLight ? 'text-gray-400' : 'text-gray-500';
  const hoverBg = isLight ? 'hover:bg-gray-100' : 'hover:bg-white/[0.06]';
  const borderB = isLight ? 'border-gray-200' : 'border-white/[0.06]';

  return {
    tabId,
    currentMedia,
    isLoading,
    downloadState,
    setDownloadState,
    selectedVariants,
    setSelectedVariants,
    view,
    setView,
    moreMenuId,
    setMoreMenuId,
    editingId,
    setEditingId,
    editName,
    setEditName,
    downloads,
    settings,
    history,
    isLight,
    onDownload,
    onCancel,
    onPause,
    onRetry,
    onClearDownloads,
    clearTabDetections,
    copyUrl,
    startEdit,
    toggleHlsMerge,
    clearHistory,
    bg,
    text,
    textMuted,
    borderB,
    hoverBg,
  };
};
