import { cn } from '../../utils';
import { formatSpeed } from '@extension/shared';
import { useEffect, useRef, useState } from 'react';
import type { MediaDownloadProgress } from '@extension/shared';

export const DownloadProgress = ({ progress, isLight }: { progress: MediaDownloadProgress; isLight: boolean }) => {
  const prevRef = useRef<{ bytes: number; time: number } | null>(null);
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const prev = prevRef.current;
    if (prev && progress.downloadedBytes > prev.bytes) {
      const elapsed = (now - prev.time) / 1000;
      if (elapsed > 0.25) {
        const raw = (progress.downloadedBytes - prev.bytes) / elapsed;
        setSpeed(s => s * 0.3 + raw * 0.7);
        prevRef.current = { bytes: progress.downloadedBytes, time: now };
      }
    } else if (!prev) {
      prevRef.current = { bytes: progress.downloadedBytes, time: now };
    }
  }, [progress.downloadedBytes]);

  const isMuxing = progress.stage === 'mux';
  const isFinalizing = progress.stage === 'finalize';
  const isFailed = progress.stage === 'failed';
  const isCancelled = progress.stage === 'cancelled';
  const isActive = !isFailed && !isCancelled;
  const isPostDownload = isMuxing || isFinalizing;

  // Once we're past byte download (mux/finalize), only show a real percent if
  // muxPercent is reported (current libav build doesn't). Otherwise pct stays
  // undefined → bar renders as indeterminate so the user sees "processing"
  // instead of a stale 100% that looks frozen.
  const pct = isPostDownload
    ? progress.muxPercent
    : progress.estimatedBytes
      ? Math.min(100, Math.round((progress.downloadedBytes / progress.estimatedBytes) * 100))
      : undefined;

  const barColor =
    isFailed || isCancelled
      ? isLight
        ? 'bg-red-400'
        : 'bg-red-500'
      : isPostDownload
        ? isLight
          ? 'bg-amber-400'
          : 'bg-amber-500'
        : 'bg-blue-500';

  const label = isCancelled
    ? 'Cancelled'
    : isFailed && progress.error
      ? progress.error.slice(0, 30)
      : isMuxing
        ? pct !== undefined
          ? `Processing ${pct}%`
          : 'Processing...'
        : isFinalizing
          ? 'Saving...'
          : pct !== undefined
            ? `${pct}%`
            : progress.stage;

  const speedText = speed > 0 && isActive && !isPostDownload ? formatSpeed(speed) : '';

  return (
    <div className={cn('relative h-5 w-full overflow-hidden rounded-md', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')}>
      <div
        className={cn('absolute inset-y-0 left-0 rounded-md transition-[width] duration-300', barColor)}
        style={{
          width: pct !== undefined ? `${pct}%` : isActive ? '100%' : '0%',
          opacity: pct === undefined && isActive ? 0.3 : 1,
        }}
      />
      <div className="relative flex h-full items-center justify-between px-2">
        <span
          className={cn(
            'text-[10px] font-semibold leading-none',
            isActive ? 'text-white drop-shadow-sm' : isLight ? 'text-red-700' : 'text-red-400',
          )}>
          {label}
        </span>
        {speedText ? (
          <span
            className={cn(
              'text-[10px] font-medium tabular-nums leading-none',
              isLight ? 'text-gray-600' : 'text-white/70 drop-shadow-sm',
            )}>
            {speedText}
          </span>
        ) : null}
      </div>
    </div>
  );
};
