import { IconClock } from './icons';
import { cn } from '../../utils';
import { formatFileSize, formatSpeed } from '@extension/shared';
import { useEffect, useRef, useState } from 'react';
import type { MediaDownloadProgress } from '@extension/shared';

// Speed is the byte delta across a sliding window of recent progress samples,
// not between two adjacent updates: worker progress arrives in bursts (several
// parallel segment fetches can complete within one repaint), and an
// instantaneous rate computed across one burst gap spikes to absurd values
// (hundreds of MB/s) that no smoothing factor can hide.
const SPEED_WINDOW_MS = 4_000;
// Don't show a rate until the window spans enough wall-clock time to mean
// something — below this the first burst dominates.
const SPEED_MIN_SPAN_MS = 800;

export const DownloadProgress = ({ progress, isLight }: { progress: MediaDownloadProgress; isLight: boolean }) => {
  const samplesRef = useRef<{ key: string; stage: string; samples: { bytes: number; time: number }[] }>({
    key: '',
    stage: '',
    samples: [],
  });
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const tracker = samplesRef.current;
    const lastSample = tracker.samples[tracker.samples.length - 1];
    // A different download, a stage flip (downloadedBytes changes meaning per
    // stage — segment bytes vs mux output bytes), or a counter reset all
    // invalidate the window; mixing samples across them fabricates rates.
    if (
      tracker.key !== progress.key ||
      tracker.stage !== progress.stage ||
      (lastSample && progress.downloadedBytes < lastSample.bytes)
    ) {
      tracker.key = progress.key;
      tracker.stage = progress.stage;
      tracker.samples = [];
      setSpeed(0);
    }
    tracker.samples.push({ bytes: progress.downloadedBytes, time: now });
    // Keep ≥2 samples so the rate still computes when progress updates arrive
    // sparsely (large HLS segments can land >window apart). Shifting down to a
    // single sample collapses the span to 0 and hides the speed entirely.
    while (tracker.samples.length > 2 && now - tracker.samples[0].time > SPEED_WINDOW_MS) {
      tracker.samples.shift();
    }
    const first = tracker.samples[0];
    const last = tracker.samples[tracker.samples.length - 1];
    const spanMs = last.time - first.time;
    if (spanMs >= SPEED_MIN_SPAN_MS && last.bytes > first.bytes) {
      setSpeed(((last.bytes - first.bytes) / spanMs) * 1000);
    }
  }, [progress.downloadedBytes, progress.stage, progress.key]);

  const isMuxing = progress.stage === 'mux';
  const isFinalizing = progress.stage === 'finalize';
  const isFailed = progress.stage === 'failed';
  const isCancelled = progress.stage === 'cancelled';
  const isQueued = progress.stage === 'queued';
  const isRecording = progress.stage === 'recording';
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
      : isQueued
        ? isLight
          ? 'bg-gray-300'
          : 'bg-white/[0.12]'
        : isPostDownload
          ? isLight
            ? 'bg-amber-400'
            : 'bg-amber-500'
          : 'bg-blue-500';

  const label = isCancelled
    ? 'Cancelled'
    : isFailed && progress.error
      ? progress.error.slice(0, 30)
      : isQueued
        ? progress.queuePosition && progress.queuePosition > 1
          ? `Queued · #${progress.queuePosition}`
          : 'Queued'
        : isMuxing
          ? pct !== undefined
            ? `Processing ${pct}%`
            : 'Processing...'
          : isFinalizing
            ? 'Saving...'
            : isRecording
              ? 'Recording…'
              : progress.stage === 'recording-paused'
                ? 'Paused'
                : pct !== undefined
                  ? `${pct}%`
                  : progress.downloadedBytes > 0
                    ? `Downloading ${formatFileSize(progress.downloadedBytes)}`
                    : 'Downloading…';

  const speedText = speed > 0 && isActive && !isPostDownload && !isQueued ? formatSpeed(speed) : '';

  return (
    <div className={cn('relative h-5 w-full overflow-hidden rounded-md', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')}>
      <div
        className={cn('absolute inset-y-0 left-0 rounded-md transition-[width] duration-300', barColor)}
        style={{
          width: isQueued ? '100%' : pct !== undefined ? `${pct}%` : isActive ? '100%' : '0%',
          opacity: isQueued ? 1 : pct === undefined && isActive ? 0.3 : 1,
        }}
      />
      <div className="relative flex h-full items-center justify-between px-2">
        <span
          className={cn(
            'text-[10px] font-semibold leading-none',
            isQueued && 'flex items-center gap-1',
            isQueued
              ? isLight
                ? 'text-gray-600'
                : 'text-gray-300'
              : isActive
                ? 'text-white drop-shadow-sm'
                : isLight
                  ? 'text-red-700'
                  : 'text-red-400',
          )}>
          {isQueued ? <IconClock /> : null}
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
