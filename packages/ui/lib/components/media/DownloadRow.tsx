import { cn } from '../../utils';
import { formatDuration } from '@extension/shared';
import type { MediaDownloadProgress } from '@extension/shared';
import { DownloadProgress } from './DownloadProgress';
import { IconFolder, IconPause, IconPlay, IconRefresh, IconTrash, IconVideo, IconX } from './icons';

const ACTIVE_STAGES = new Set(['init', 'fetch-manifest', 'download-video', 'download-audio', 'mux', 'finalize']);

export const DownloadRow = ({
  entry,
  isLight,
  onRetry,
  onPause,
  onCancel,
  onRemove,
}: {
  entry: MediaDownloadProgress;
  isLight: boolean;
  onRetry: (entry: MediaDownloadProgress) => void;
  onPause: (key: string) => void;
  onCancel: (key: string) => void;
  onRemove: (key: string) => void;
}) => {
  const item = entry.item;
  const isActive = ACTIVE_STAGES.has(entry.stage);
  const isSuccess = entry.stage === 'success';
  const isFailed = entry.stage === 'failed';
  const isCancelled = entry.stage === 'cancelled';
  const isPaused = entry.stage === 'paused';
  const canRetry = (isFailed || isCancelled || isPaused) && !!item;

  const displayName =
    item?.title?.trim() ||
    (item?.fileName ?? entry.key).replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  const durationStr = item?.duration ? formatDuration(item.duration) : '';

  return (
    <div className={cn('group relative px-4 py-3 transition', isLight ? 'hover:bg-gray-50' : 'hover:bg-white/[0.02]')}>
      <div className="flex gap-3">
        <div
          className={cn(
            'relative h-[68px] w-[100px] shrink-0 overflow-hidden rounded-lg',
            isLight ? 'bg-gray-100' : 'bg-white/[0.04]',
          )}>
          {item?.thumbnail ? (
            <img src={item.thumbnail} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <IconVideo />
            </div>
          )}
          {durationStr ? (
            <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-white backdrop-blur-sm">
              {durationStr}
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
          <div className="flex items-start gap-1">
            <p
              className={cn(
                'min-w-0 flex-1 text-[12px] font-semibold leading-[1.4]',
                isLight ? 'text-gray-800' : 'text-gray-100',
              )}
              title={displayName}
              style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {displayName}
            </p>
            <button
              onClick={() => onRemove(entry.key)}
              className={cn(
                'mt-0.5 shrink-0 rounded-md p-1 opacity-0 transition group-hover:opacity-100',
                isLight
                  ? 'text-gray-400 hover:bg-gray-200 hover:text-gray-600'
                  : 'text-gray-600 hover:bg-white/[0.08] hover:text-gray-400',
              )}
              title="Remove from list">
              <IconTrash />
            </button>
          </div>

          {isActive ? (
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <DownloadProgress progress={entry} isLight={isLight} />
              </div>
              <button
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition',
                  isLight
                    ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                    : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25',
                )}
                title="Pause (remembers intent to resume)"
                onClick={() => onPause(entry.key)}>
                <IconPause /> Pause
              </button>
              <button
                className={cn(
                  'shrink-0 rounded-md p-1 transition',
                  isLight
                    ? 'bg-red-100 text-red-600 hover:bg-red-200'
                    : 'bg-red-500/15 text-red-400 hover:bg-red-500/25',
                )}
                title="Cancel download"
                onClick={() => onCancel(entry.key)}>
                <IconX />
              </button>
            </div>
          ) : isSuccess ? (
            <div className="flex items-center gap-1.5">
              {entry.downloadId !== undefined ? (
                <>
                  <button
                    className={cn(
                      'flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition',
                      isLight
                        ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                        : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25',
                    )}
                    onClick={() =>
                      chrome.runtime.sendMessage({ type: 'media/open', downloadId: entry.downloadId })
                    }>
                    <IconPlay /> Play
                  </button>
                  <button
                    className={cn(
                      'flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition',
                      isLight
                        ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        : 'bg-white/[0.06] text-gray-300 hover:bg-white/[0.1]',
                    )}
                    onClick={() =>
                      chrome.runtime.sendMessage({ type: 'media/show', downloadId: entry.downloadId })
                    }>
                    <IconFolder /> Show in Folder
                  </button>
                </>
              ) : (
                <span className={cn('text-[11px] font-medium', isLight ? 'text-emerald-600' : 'text-emerald-400')}>
                  Completed
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'flex items-center gap-1 text-[11px] font-semibold',
                  isPaused
                    ? isLight
                      ? 'text-amber-600'
                      : 'text-amber-400'
                    : isLight
                      ? 'text-red-600'
                      : 'text-red-400',
                )}>
                {isPaused ? <IconPause /> : <IconX />}
                {isPaused
                  ? 'Paused'
                  : isCancelled
                    ? 'Cancelled'
                    : entry.error
                      ? entry.error.slice(0, 40)
                      : 'Failed'}
              </span>
              <div className="flex-1" />
              {canRetry ? (
                <button
                  className="flex items-center gap-1 rounded-full bg-blue-500 px-3 py-1 text-[11px] font-semibold text-white shadow-sm shadow-blue-500/25 transition hover:bg-blue-600 active:scale-[0.97]"
                  onClick={() => onRetry(entry)}>
                  {isPaused ? (
                    <>
                      <IconPlay /> Resume
                    </>
                  ) : (
                    <>
                      <IconRefresh /> Retry
                    </>
                  )}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
