import { DownloadProgress } from './DownloadProgress';
import { IconDownload, IconX, IconEdit, IconMoreVert, IconVideo, IconPlay, IconFolder, IconLock } from './icons';
import { MenuItem } from './MenuItem';
import { cn } from '../../utils';
import {
  MEDIA_MESSAGE,
  kindLabel,
  kindBadgeColor,
  pickBestVariant,
  variantLabel,
  formatDuration,
} from '@extension/shared';
import { useEffect, useRef } from 'react';
import type {
  DownloadState,
  SubtitleTrack,
  MediaDownloadProgress,
  MediaItem,
  MediaSettings,
  MediaVariant,
} from '@extension/shared';

export const MediaCard = ({
  item,
  isLight,
  downloadState,
  downloads,
  selectedVariants,
  setSelectedVariants,
  settings,
  moreMenuId,
  setMoreMenuId,
  editingId,
  setEditingId,
  editName,
  setEditName,
  onDownload,
  onCancel,
  startEdit,
  copyUrl,
  onDismiss,
  textMuted,
}: {
  item: MediaItem;
  isLight: boolean;
  downloadState: DownloadState;
  downloads: Record<string, MediaDownloadProgress>;
  selectedVariants: Record<string, string>;
  setSelectedVariants: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  settings: MediaSettings | null;
  moreMenuId: string | null;
  setMoreMenuId: (id: string | null) => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  editName: string;
  setEditName: (name: string) => void;
  onDownload: (item: MediaItem, fmt?: 'mp4' | 'mp3') => void;
  onCancel: (url: string) => void;
  startEdit: (item: MediaItem) => void;
  copyUrl: (url: string) => void;
  onDismiss: () => void;
  textMuted: string;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (moreMenuId !== item.id) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMoreMenuId(null);
    };
    const timerId = setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 0);
    return () => {
      clearTimeout(timerId);
      document.removeEventListener('mousedown', handler);
    };
  }, [moreMenuId, item.id, setMoreMenuId]);

  const isEditing = editingId === item.id;
  const isMenuOpen = moreMenuId === item.id;
  const ACTIVE_STAGES = new Set(['init', 'fetch-manifest', 'download-video', 'download-audio', 'mux', 'finalize']);
  const progress = downloads[item.url];
  const isBusy = downloadState.busyUrl === item.url || (progress != null && ACTIVE_STAGES.has(progress.stage));
  const isComplete = progress?.stage === 'success' && progress.downloadId;

  const selectedVariantUrl = selectedVariants[item.id];
  const bestVariant = item.variants?.length ? pickBestVariant(item.variants) : undefined;
  const currentVariantUrl = selectedVariantUrl ?? bestVariant?.url ?? item.variants?.[0]?.url;
  const currentVariant = item.variants?.find((v: MediaVariant) => v.url === currentVariantUrl);
  const resLabel = currentVariant?.resolution
    ? `${currentVariant.resolution.height}p`
    : item.variants?.length
      ? 'Auto'
      : '';
  const formatLabel = item.kind === 'audio' ? 'MP3' : 'MP4';
  const displayName = item.title?.trim() || (item.fileName ?? item.url).replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  const durationStr = item.duration ? formatDuration(item.duration) : '';

  const downloadSubtitle = (track: SubtitleTrack) => {
    setMoreMenuId(null);
    chrome.runtime
      .sendMessage({
        type: MEDIA_MESSAGE.DOWNLOAD,
        payload: {
          url: track.url,
          key: track.url,
          kind: 'subtitle',
          subtitleFormat: track.format,
          subtitleLang: track.language,
          fileName: item.fileName,
          title: item.title,
        },
      })
      .catch(() => undefined);
  };

  return (
    <div className={cn('group relative px-4 py-3 transition', isLight ? 'hover:bg-gray-50' : 'hover:bg-white/[0.02]')}>
      <div className="flex gap-3">
        {/* Thumbnail */}
        <div
          className={cn(
            'relative h-[68px] w-[100px] shrink-0 overflow-hidden rounded-lg',
            isLight ? 'bg-gray-100' : 'bg-white/[0.04]',
          )}>
          {item.thumbnail ? (
            <img src={item.thumbnail} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <IconVideo />
            </div>
          )}
          {/* Kind badge */}
          <span
            className={cn(
              'absolute left-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none shadow-sm backdrop-blur-md',
              kindBadgeColor(item.kind, isLight),
            )}>
            {kindLabel(item.kind)}
          </span>
          {durationStr ? (
            <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-white backdrop-blur-sm">
              {durationStr}
            </span>
          ) : null}
          {item.subtitles && item.subtitles.length > 0 ? (
            <span
              className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white backdrop-blur-sm"
              title={`${item.subtitles.length} subtitle track${item.subtitles.length > 1 ? 's' : ''} available`}>
              CC
            </span>
          ) : null}
          {item.isDrmProtected ? (
            <span
              className="absolute right-1.5 top-1.5 flex items-center rounded-md bg-red-500/90 p-1 text-white shadow-sm backdrop-blur-sm"
              title="DRM-protected stream — cannot be downloaded">
              <IconLock />
            </span>
          ) : null}
        </div>

        {/* Info */}
        <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
          <div className="flex items-start gap-1">
            {isEditing ? (
              <div className="flex-1">
                <input
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className={cn(
                    'w-full rounded-md border px-2 py-1 text-xs font-medium outline-none',
                    isLight ? 'border-blue-300 bg-white' : 'border-blue-500/50 bg-white/[0.05]',
                  )}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === 'Escape') setEditingId(null);
                  }}
                />
              </div>
            ) : (
              <p
                className={cn(
                  'min-w-0 flex-1 text-[12px] font-semibold leading-[1.4]',
                  isLight ? 'text-gray-800' : 'text-gray-100',
                )}
                title={displayName}
                style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {displayName}
              </p>
            )}
            <button
              onClick={onDismiss}
              className={cn(
                'mt-0.5 shrink-0 rounded-md p-1 opacity-0 transition group-hover:opacity-100',
                isLight
                  ? 'text-gray-400 hover:bg-gray-200 hover:text-gray-600'
                  : 'text-gray-600 hover:bg-white/[0.08] hover:text-gray-400',
              )}
              title="Dismiss">
              <IconX />
            </button>
          </div>

          {/* Actions */}
          {item.isDrmProtected ? (
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold',
                  isLight ? 'bg-red-50 text-red-600' : 'bg-red-500/15 text-red-400',
                )}
                title="This stream is DRM-protected (Widevine, PlayReady, or FairPlay). Vidsy cannot decrypt protected streams.">
                <IconLock /> DRM-protected
              </span>
            </div>
          ) : isComplete ? (
            <div className="flex items-center gap-1.5">
              <button
                className={cn(
                  'flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition',
                  isLight
                    ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                    : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25',
                )}
                onClick={() => chrome.runtime.sendMessage({ type: 'media/open', downloadId: progress.downloadId })}>
                <IconPlay /> Play
              </button>
              <button
                className={cn(
                  'flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition',
                  isLight
                    ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    : 'bg-white/[0.06] text-gray-300 hover:bg-white/[0.1]',
                )}
                onClick={() => chrome.runtime.sendMessage({ type: 'media/show', downloadId: progress.downloadId })}>
                <IconFolder /> Show in Folder
              </button>
            </div>
          ) : isBusy && progress ? (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <DownloadProgress progress={progress} isLight={isLight} />
              </div>
              <button
                className={cn(
                  'shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold transition',
                  isLight
                    ? 'bg-red-100 text-red-600 hover:bg-red-200'
                    : 'bg-red-500/15 text-red-400 hover:bg-red-500/25',
                )}
                onClick={() => onCancel(item.url)}>
                Stop
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                className={cn(
                  'rounded-md p-1 transition',
                  isLight
                    ? 'text-gray-400 hover:bg-gray-200 hover:text-gray-600'
                    : 'text-gray-500 hover:bg-white/[0.08] hover:text-gray-300',
                )}
                onClick={() => startEdit(item)}
                title="Rename">
                <IconEdit />
              </button>
              <span className={cn('text-[10px] font-semibold', textMuted)}>{formatLabel}</span>
              {item.variants && item.variants.length > 1 ? (
                <select
                  className={cn(
                    'rounded-md border px-1.5 py-0.5 text-[10px] font-bold outline-none',
                    isLight
                      ? 'border-gray-200 bg-gray-100 text-gray-700'
                      : 'border-white/[0.08] bg-white/[0.06] text-gray-300',
                  )}
                  value={currentVariantUrl}
                  onChange={e => setSelectedVariants(prev => ({ ...prev, [item.id]: e.target.value }))}>
                  {item.variants.map((v: MediaVariant) => (
                    <option
                      key={v.url}
                      value={v.url}
                      className={isLight ? 'bg-white text-gray-800' : 'bg-gray-800 text-gray-200'}>
                      {variantLabel(v)}
                    </option>
                  ))}
                </select>
              ) : resLabel ? (
                <span
                  className={cn(
                    'rounded-md border px-1.5 py-0.5 text-[10px] font-bold',
                    isLight
                      ? 'border-gray-200 bg-gray-100 text-gray-700'
                      : 'border-white/[0.08] bg-white/[0.06] text-gray-300',
                  )}>
                  {resLabel}
                </span>
              ) : null}
              <div className="flex-1" />
              <button
                className="flex items-center gap-1 rounded-full bg-blue-500 px-3 py-1 text-[11px] font-semibold text-white shadow-sm shadow-blue-500/25 transition hover:bg-blue-600 active:scale-[0.97]"
                onClick={() => onDownload(item)}>
                <IconDownload /> Download
              </button>
              <div className="relative" ref={menuRef}>
                <button
                  className={cn(
                    'rounded-md p-1 transition',
                    isLight
                      ? 'text-gray-400 hover:bg-gray-200 hover:text-gray-600'
                      : 'text-gray-500 hover:bg-white/[0.08] hover:text-gray-300',
                  )}
                  onClick={e => {
                    e.stopPropagation();
                    setMoreMenuId(isMenuOpen ? null : item.id);
                  }}>
                  <IconMoreVert />
                </button>
                {isMenuOpen ? (
                  <div
                    className={cn(
                      'absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-xl border py-1 shadow-xl',
                      isLight ? 'border-gray-200 bg-white' : 'border-white/[0.08] bg-[#1a1d24]',
                    )}>
                    <MenuItem label="Download video" onClick={() => onDownload(item)} isLight={isLight} />
                    {(item.kind === 'hls' || item.kind === 'dash' || item.kind === 'video') &&
                    settings?.enableHlsMerging ? (
                      <MenuItem label="Download audio only" onClick={() => onDownload(item, 'mp3')} isLight={isLight} />
                    ) : null}
                    {item.subtitles && item.subtitles.length > 0 ? (
                      <>
                        <div
                          className={cn('mx-2 my-1 border-t', isLight ? 'border-gray-100' : 'border-white/[0.06]')}
                        />
                        <div
                          className={cn(
                            'px-3 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-wider',
                            isLight ? 'text-gray-400' : 'text-gray-500',
                          )}>
                          Subtitles
                        </div>
                        <div className="max-h-44 overflow-y-auto">
                          {item.subtitles.map(track => (
                            <MenuItem
                              key={track.url}
                              label={`${track.label ?? track.language}${track.isAutoGenerated ? ' (auto)' : ''}`}
                              onClick={() => downloadSubtitle(track)}
                              isLight={isLight}
                            />
                          ))}
                        </div>
                      </>
                    ) : null}
                    <div className={cn('mx-2 my-1 border-t', isLight ? 'border-gray-100' : 'border-white/[0.06]')} />
                    <MenuItem label="Copy URL" onClick={() => copyUrl(item.url)} isLight={isLight} />
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
