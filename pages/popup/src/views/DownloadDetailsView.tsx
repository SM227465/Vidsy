// Standalone single-download details view.
//
// Rendered inside the popup HTML when opened with #download-details (which is
// what the download interceptor uses for its standalone progress window).
// Auto-focuses on the most recent active download.
//
// NOT yet shown: per-connection breakdown rendering the byte-range layout of
// each parallel connection. That needs the offscreen worker to report per-
// chunk progress — currently we only get aggregate bytes.

import { MEDIA_MESSAGE, formatSpeed } from '@extension/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChunkProgress, MediaDownloadProgress } from '@extension/shared';

const ACTIVE_STAGES = new Set([
  'queued',
  'init',
  'fetch-manifest',
  'download-video',
  'download-audio',
  'mux',
  'finalize',
]);

const formatBytes = (bytes: number | undefined): string => {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 2)} ${units[i]}`;
};

const formatTimeLeft = (seconds: number | undefined): string => {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} sec`;
  return `${Math.floor(seconds / 3600)} hr ${Math.floor((seconds % 3600) / 60)} min`;
};

const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued',
  init: 'Starting…',
  'fetch-manifest': 'Fetching manifest…',
  'download-video': 'Receiving data…',
  'download-audio': 'Receiving audio…',
  mux: 'Processing…',
  finalize: 'Saving…',
  success: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  paused: 'Paused',
};

type Props = {
  downloads: Record<string, MediaDownloadProgress>;
  isLight: boolean;
};

const pickFocusedDownload = (downloads: Record<string, MediaDownloadProgress>): MediaDownloadProgress | null => {
  const entries = Object.values(downloads);
  if (entries.length === 0) return null;
  // Prefer most recent active; fall back to most recent overall.
  const active = entries
    .filter(e => ACTIVE_STAGES.has(e.stage))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  if (active.length > 0) return active[0];
  return entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
};

// dlKey on the query string pins this window to a single download — the
// interceptor spawns one window per intercepted file. Absent: fall back to
// picking the most-recent active download (covers the no-key entry path).
const readDlKey = (): string | null => {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('dlKey');
};

export const DownloadDetailsView = ({ downloads, isLight }: Props) => {
  const dlKey = useMemo(() => readDlKey(), []);
  const entry = useMemo(() => {
    if (dlKey) return downloads[dlKey] ?? null;
    return pickFocusedDownload(downloads);
  }, [downloads, dlKey]);

  // Smoothed speed and start-time tracking.
  const prevRef = useRef<{ bytes: number; time: number } | null>(null);
  const [speed, setSpeed] = useState(0);
  const lastKeyRef = useRef<string | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(true);

  // Stall detection: track when downloadedBytes last increased. The 1-Hz tick
  // forces re-render so we can flip the status label to "Connecting…" when
  // the stage is in a download phase but no bytes are arriving.
  const lastProgressAtRef = useRef<number>(Date.now());
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!entry) return;
    // Reset on switch to a different download.
    if (lastKeyRef.current !== entry.key) {
      lastKeyRef.current = entry.key;
      prevRef.current = null;
      setSpeed(0);
      lastProgressAtRef.current = Date.now();
    }
    const now = Date.now();
    const prev = prevRef.current;
    if (prev && entry.downloadedBytes > prev.bytes) {
      lastProgressAtRef.current = now;
      const elapsed = (now - prev.time) / 1000;
      if (elapsed > 0.25) {
        const raw = (entry.downloadedBytes - prev.bytes) / elapsed;
        setSpeed(s => s * 0.3 + raw * 0.7);
        prevRef.current = { bytes: entry.downloadedBytes, time: now };
      }
    } else if (!prev) {
      prevRef.current = { bytes: entry.downloadedBytes, time: now };
    }
    // If bytes haven't moved for a while, decay the smoothed speed to 0 so
    // the UI doesn't keep reporting stale throughput.
    if (now - lastProgressAtRef.current > 3000 && speed > 0) {
      setSpeed(0);
    }
  }, [entry, speed]);

  const onPause = () => {
    if (!entry) return;
    void chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CANCEL, payload: { url: entry.key, intent: 'pause' } });
  };
  const onCancel = () => {
    if (!entry) return;
    void chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CANCEL, payload: { url: entry.key, intent: 'cancel' } });
  };

  const bg = isLight ? 'bg-white' : 'bg-[#0f1117]';
  const text = isLight ? 'text-gray-900' : 'text-gray-100';
  const muted = isLight ? 'text-gray-500' : 'text-gray-400';
  const labelCol = isLight ? 'text-gray-500' : 'text-gray-400';
  const valueCol = isLight ? 'text-gray-900' : 'text-gray-100';
  const card = isLight ? 'bg-gray-50 border-gray-200' : 'bg-white/[0.02] border-white/[0.06]';

  if (!entry) {
    return (
      <div className={`flex h-full w-full flex-col items-center justify-center font-sans ${bg} ${text}`}>
        <p className={`text-sm ${muted}`}>{dlKey ? 'Starting download…' : 'No active downloads'}</p>
      </div>
    );
  }

  const fileName = entry.item?.fileName ?? entry.item?.title ?? entry.key;
  const sourceUrl = entry.item?.pageUrl ?? entry.item?.url ?? entry.key;
  const sourceHost = (() => {
    try {
      return new URL(sourceUrl).hostname;
    } catch {
      return sourceUrl;
    }
  })();
  const totalBytes = entry.estimatedBytes ?? 0;
  const downloadedBytes = entry.downloadedBytes ?? 0;
  const pct = totalBytes > 0 ? Math.min(100, (downloadedBytes / totalBytes) * 100) : (entry.muxPercent ?? null);
  const isActive = ACTIVE_STAGES.has(entry.stage);
  const isMuxing = entry.stage === 'mux' || entry.stage === 'finalize';
  const eta = speed > 0 && totalBytes > downloadedBytes ? (totalBytes - downloadedBytes) / speed : undefined;
  const isHttpDirect = entry.item?.kind === 'video' || entry.item?.kind === 'audio';
  const resumeCapability = isHttpDirect ? 'Yes (Range)' : 'During mux only';

  // Honest status: if stage is a download phase but no bytes have arrived in
  // the last 5s, show "Connecting…" instead of the optimistic "Receiving…".
  const isDownloadStage = entry.stage === 'download-video' || entry.stage === 'download-audio';
  const stalledMs = Date.now() - lastProgressAtRef.current;
  const isStalled = isDownloadStage && stalledMs > 5000;
  const statusText = isStalled
    ? stalledMs > 30_000
      ? 'Stalled — waiting for server…'
      : 'Connecting…'
    : (STAGE_LABEL[entry.stage] ?? entry.stage);

  // Download Complete view — replaces the in-progress UI when stage='success'.
  if (entry.stage === 'success') {
    const openFile = () => {
      if (entry.downloadId !== undefined) {
        void chrome.runtime.sendMessage({ type: 'media/open', downloadId: entry.downloadId });
      }
    };
    const openFolder = () => {
      if (entry.downloadId !== undefined) {
        void chrome.runtime.sendMessage({ type: 'media/show', downloadId: entry.downloadId });
      }
    };
    const closeWindow = () => window.close();

    return (
      <div className={`flex h-full w-full flex-col font-sans ${bg} ${text}`}>
        <div className={`border-b px-5 py-3 ${isLight ? 'border-gray-200' : 'border-white/[0.06]'}`}>
          <p className="truncate text-[13px] font-bold leading-snug">Download complete</p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 flex items-center gap-3">
            <div
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${
                isLight ? 'bg-emerald-100 text-emerald-600' : 'bg-emerald-500/15 text-emerald-400'
              }`}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className={`text-[12px] font-semibold ${valueCol}`}>Downloaded {formatBytes(downloadedBytes)}</p>
              <p className={`mt-0.5 truncate text-[11px] ${muted}`} title={fileName}>
                {fileName}
              </p>
            </div>
          </div>

          <div className={`mb-2 rounded-lg border px-4 py-2 ${card}`}>
            <p className={`text-[10px] uppercase tracking-wider ${labelCol}`}>Address</p>
            <p className={`mt-1 truncate text-[11px] ${isLight ? 'text-blue-600' : 'text-blue-400'}`} title={sourceUrl}>
              {sourceHost}
            </p>
          </div>

          <div className={`mb-4 rounded-lg border px-4 py-2 ${card}`}>
            <p className={`text-[10px] uppercase tracking-wider ${labelCol}`}>The file saved as</p>
            <p className={`mt-1 truncate text-[11px] ${valueCol}`} title={fileName}>
              {fileName}
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={openFile}
              disabled={entry.downloadId === undefined}
              className={`min-w-[90px] rounded-md px-4 py-2 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                isLight
                  ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                  : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
              }`}>
              Open
            </button>
            <button
              onClick={openFolder}
              disabled={entry.downloadId === undefined}
              className={`min-w-[110px] rounded-md px-4 py-2 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                isLight
                  ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  : 'bg-white/[0.06] text-gray-300 hover:bg-white/[0.1]'
              }`}>
              Open folder
            </button>
            <button
              onClick={closeWindow}
              className={`min-w-[90px] rounded-md px-4 py-2 text-[12px] font-semibold transition ${
                isLight
                  ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  : 'bg-white/[0.06] text-gray-300 hover:bg-white/[0.1]'
              }`}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-full w-full flex-col font-sans ${bg} ${text}`}>
      {/* Filename header */}
      <div className={`border-b px-5 py-3 ${isLight ? 'border-gray-200' : 'border-white/[0.06]'}`}>
        <p className="truncate text-[13px] font-bold leading-snug" title={fileName}>
          {fileName}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3">
        {/* Source — host only to keep the layout compact; full URL on hover */}
        <div className="mb-3 flex items-baseline gap-3">
          <span className={`shrink-0 text-[10px] uppercase tracking-wider ${labelCol}`}>Source</span>
          <span className={`truncate text-[11px] ${isLight ? 'text-blue-600' : 'text-blue-400'}`} title={sourceUrl}>
            {sourceHost}
          </span>
        </div>

        {/* Stats — single column for the narrower window */}
        <div className={`mb-3 space-y-1.5 rounded-lg border px-4 py-3 ${card}`}>
          <div className="flex items-center justify-between">
            <span className={`text-[11px] ${labelCol}`}>Status</span>
            <span className={`text-[11px] font-medium ${valueCol}`}>{statusText}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className={`text-[11px] ${labelCol}`}>File size</span>
            <span className={`font-mono text-[11px] font-medium ${valueCol}`}>{formatBytes(totalBytes)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className={`text-[11px] ${labelCol}`}>Downloaded</span>
            <span className={`font-mono text-[11px] font-medium ${valueCol}`}>
              {formatBytes(downloadedBytes)}
              {pct !== null && <span className={`ml-1.5 ${muted}`}>({pct.toFixed(1)}%)</span>}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className={`text-[11px] ${labelCol}`}>Transfer rate</span>
            <span className={`font-mono text-[11px] font-medium ${valueCol}`}>
              {speed > 0 && !isMuxing ? formatSpeed(speed) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className={`text-[11px] ${labelCol}`}>Time left</span>
            <span className={`font-mono text-[11px] font-medium ${valueCol}`}>{formatTimeLeft(eta)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className={`text-[11px] ${labelCol}`}>Resume</span>
            <span className={`text-[11px] font-medium ${valueCol}`}>{resumeCapability}</span>
          </div>
        </div>

        {/* Progress bar */}
        <div
          className={`relative mb-3 h-6 w-full overflow-hidden rounded-md ${isLight ? 'bg-gray-200' : 'bg-white/[0.06]'}`}>
          <div
            className={`absolute inset-y-0 left-0 rounded-md transition-[width] duration-300 ${
              entry.stage === 'failed' || entry.stage === 'cancelled'
                ? 'bg-red-500'
                : isMuxing
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
            }`}
            style={{
              width: pct !== null ? `${pct}%` : isActive ? '100%' : '0%',
              opacity: pct === null && isActive ? 0.3 : 1,
            }}
          />
          <div className="relative flex h-full items-center justify-center">
            <span className="text-[11px] font-semibold text-white drop-shadow-sm">
              {pct !== null ? `${pct.toFixed(1)}%` : statusText}
            </span>
          </div>
        </div>

        {/* Per-connection accordion — collapsible header */}
        <div className={`mb-3 rounded-lg border ${card}`}>
          <button
            type="button"
            onClick={() => setConnectionsOpen(o => !o)}
            className={`flex w-full items-center justify-between px-4 py-2 text-left transition ${
              isLight ? 'hover:bg-gray-100' : 'hover:bg-white/[0.04]'
            }`}>
            <span className={`text-[10px] uppercase tracking-wider ${labelCol}`}>
              Start positions and download progress by connections
            </span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: connectionsOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 150ms',
                color: isLight ? '#6b7280' : '#9ca3af',
              }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {connectionsOpen && (
            <div className={`border-t px-4 py-3 ${isLight ? 'border-gray-200' : 'border-white/[0.06]'}`}>
              {entry.chunks && entry.chunks.length > 0 ? (
                (() => {
                  const chunks = entry.chunks;
                  const fileEnd = chunks.reduce((m, c) => Math.max(m, c.end + 1), 0);
                  const totalForBar = Math.max(entry.estimatedBytes ?? 0, fileEnd, 1);
                  const colorFor = (status: ChunkProgress['status']) =>
                    status === 'done'
                      ? 'bg-emerald-500'
                      : status === 'fetching'
                        ? 'bg-blue-500'
                        : status === 'error'
                          ? 'bg-red-500'
                          : isLight
                            ? 'bg-gray-400'
                            : 'bg-white/[0.18]';
                  const statusTextColor = (status: ChunkProgress['status']) => {
                    if (status === 'done') return isLight ? 'text-emerald-700' : 'text-emerald-400';
                    if (status === 'fetching') return isLight ? 'text-blue-700' : 'text-blue-400';
                    if (status === 'error') return isLight ? 'text-red-700' : 'text-red-400';
                    return muted;
                  };
                  return (
                    <>
                      {/* Position bar */}
                      <div
                        className={`relative h-4 w-full overflow-hidden rounded ${isLight ? 'bg-gray-200' : 'bg-white/[0.06]'}`}>
                        {chunks.map(c => {
                          const leftPct = (c.start / totalForBar) * 100;
                          const widthPct = ((c.end - c.start + 1) / totalForBar) * 100;
                          return (
                            <div
                              key={c.i}
                              className={`absolute bottom-0 top-0 ${colorFor(c.status)} ${c.status === 'fetching' ? 'animate-pulse' : ''}`}
                              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                              title={`Connection ${c.i + 1}: ${c.status}`}
                            />
                          );
                        })}
                      </div>

                      {/* Chunk table */}
                      <table className="mt-3 w-full text-[10px]">
                        <thead>
                          <tr className={labelCol}>
                            <th className="pb-1.5 text-left font-medium">N°</th>
                            <th className="pb-1.5 text-right font-medium">Range</th>
                            <th className="pb-1.5 text-right font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {chunks.map(c => (
                            <tr key={c.i}>
                              <td className={`py-0.5 ${valueCol}`}>{c.i + 1}</td>
                              <td className={`py-0.5 text-right font-mono ${valueCol}`}>
                                {formatBytes(c.start)} – {formatBytes(c.end + 1)}
                              </td>
                              <td className={`py-0.5 text-right capitalize ${statusTextColor(c.status)}`}>
                                {c.status}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  );
                })()
              ) : (
                <p className={`text-center text-[10px] italic ${muted}`}>
                  Per-connection breakdown is only available for direct HTTP downloads with Range support
                </p>
              )}
            </div>
          )}
        </div>

        {/* Action buttons — horizontal row, right-aligned */}
        {isActive ? (
          <div className="flex justify-end gap-2">
            <button
              onClick={onPause}
              className={`min-w-[100px] rounded-md px-4 py-2 text-[12px] font-semibold transition ${
                isLight
                  ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                  : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
              }`}>
              Pause
            </button>
            <button
              onClick={onCancel}
              className={`min-w-[100px] rounded-md px-4 py-2 text-[12px] font-semibold transition ${
                isLight ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
              }`}>
              Cancel
            </button>
          </div>
        ) : (
          <div className={`text-center text-[11px] ${muted}`}>{statusText}</div>
        )}

        {/* Footnote — keep the browser alive during active downloads */}
        {isActive && (
          <p className={`mt-3 text-center text-[10px] italic ${muted}`}>
            ⚠ Please do not close the browser while the download is running
          </p>
        )}
      </div>
    </div>
  );
};
