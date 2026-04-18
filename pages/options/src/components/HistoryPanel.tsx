import { useStorage } from '@extension/shared';
import { mediaHistoryStorage } from '@extension/storage';
import { cn } from '@extension/ui';
import { useState } from 'react';
import type { MediaHistoryItem } from '@extension/shared';

const ITEMS_PER_PAGE = 5;

export const getPageFromUrl = (): number => {
  const params = new URLSearchParams(window.location.search);
  const p = parseInt(params.get('page') ?? '1', 10);
  return isFinite(p) && p > 0 ? p : 1;
};

export const setPageInUrl = (page: number) => {
  const url = new URL(window.location.href);
  url.searchParams.set('page', String(page));
  window.history.replaceState(null, '', url.toString());
};

const formatDuration = (sec?: number) => {
  if (!sec || !isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const formatDate = (ts: number) => {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const kindColor = (kind: string, isLight: boolean) => {
  const map: Record<string, string> = {
    hls: isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-500/15 text-blue-400',
    dash: isLight ? 'bg-violet-100 text-violet-700' : 'bg-violet-500/15 text-violet-400',
    video: isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-500/15 text-emerald-400',
    audio: isLight ? 'bg-amber-100 text-amber-700' : 'bg-amber-500/15 text-amber-400',
  };
  return map[kind] || (isLight ? 'bg-gray-100 text-gray-600' : 'bg-gray-500/15 text-gray-400');
};

const IconHistory = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </svg>
);

const IconCheck = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const IconXMark = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

const PaginationBtn = ({
  children,
  onClick,
  disabled,
  active,
  isLight,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  isLight: boolean;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'flex h-8 min-w-[32px] items-center justify-center rounded-lg px-2 text-sm font-medium transition',
      disabled && 'pointer-events-none opacity-30',
      active
        ? 'bg-blue-500 text-white shadow-sm'
        : isLight
          ? 'text-gray-600 hover:bg-gray-100'
          : 'text-gray-400 hover:bg-white/[0.06]',
    )}>
    {children}
  </button>
);

export const HistoryPanel = ({ isLight }: { isLight: boolean }) => {
  const history = useStorage(mediaHistoryStorage);
  const items = Array.isArray(history) ? (history as MediaHistoryItem[]) : [];
  const [page, setPage] = useState(getPageFromUrl);

  const totalPages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageItems = items.slice((safePage - 1) * ITEMS_PER_PAGE, safePage * ITEMS_PER_PAGE);

  const goTo = (p: number) => {
    const clamped = Math.max(1, Math.min(p, totalPages));
    setPage(clamped);
    setPageInUrl(clamped);
  };

  const label = isLight ? 'text-gray-800' : 'text-gray-100';
  const sub = isLight ? 'text-gray-400' : 'text-gray-500';
  const cardCls = cn(
    'overflow-hidden rounded-2xl border',
    isLight ? 'border-gray-200 bg-white shadow-sm' : 'border-white/[0.06] bg-white/[0.02]',
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className={cn('text-lg font-semibold', label)}>Download History</h2>
          <p className={cn('mt-1 text-sm', sub)}>
            {items.length} {items.length === 1 ? 'download' : 'downloads'} recorded
          </p>
        </div>
        {items.length > 0 && (
          <button
            onClick={() => {
              mediaHistoryStorage.set([]);
              goTo(1);
            }}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition',
              isLight ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-500/10',
            )}>
            Clear all
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div
          className={cn(
            'rounded-2xl border-2 border-dashed py-16 text-center',
            isLight ? 'border-gray-200' : 'border-white/[0.06]',
          )}>
          <div
            className={cn(
              'mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl',
              isLight ? 'bg-gray-100 text-gray-400' : 'bg-white/[0.04] text-gray-600',
            )}>
            <IconHistory />
          </div>
          <p className={cn('text-sm font-medium', isLight ? 'text-gray-500' : 'text-gray-400')}>No downloads yet</p>
          <p className={cn('mt-1 text-xs', sub)}>Your download history will appear here</p>
        </div>
      ) : (
        <>
          <div className={cardCls}>
            {/* Table header */}
            <div
              className={cn(
                'grid grid-cols-[1fr_80px_80px_140px_70px] gap-3 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider',
                isLight ? 'bg-gray-50 text-gray-400' : 'bg-white/[0.02] text-gray-500',
              )}>
              <span>Title</span>
              <span>Type</span>
              <span>Duration</span>
              <span>Date</span>
              <span>Status</span>
            </div>

            {/* Rows */}
            {pageItems.map((item, i) => (
              <div
                key={`${item.url}-${i}`}
                className={cn(
                  'grid grid-cols-[1fr_80px_80px_140px_70px] items-center gap-3 px-5 py-3 transition',
                  isLight
                    ? 'border-t border-gray-100 hover:bg-gray-50'
                    : 'border-t border-white/[0.04] hover:bg-white/[0.02]',
                )}>
                <div className="flex min-w-0 items-center gap-3">
                  {item.thumbnail ? (
                    <img src={item.thumbnail} alt="" className="h-9 w-14 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <div
                      className={cn(
                        'flex h-9 w-14 shrink-0 items-center justify-center rounded-lg text-[10px]',
                        isLight ? 'bg-gray-100 text-gray-400' : 'bg-white/[0.04] text-gray-600',
                      )}>
                      No img
                    </div>
                  )}
                  <p className={cn('truncate text-sm font-medium', label)}>
                    {item.title || item.fileName || 'Untitled'}
                  </p>
                </div>
                <span
                  className={cn(
                    'inline-flex w-fit rounded-md px-2 py-0.5 text-[10px] font-bold uppercase',
                    kindColor(item.kind, isLight),
                  )}>
                  {item.kind}
                </span>
                <span className={cn('text-sm tabular-nums', sub)}>{formatDuration(item.duration)}</span>
                <span className={cn('text-xs', sub)}>{formatDate(item.downloadedAt)}</span>
                <span
                  className={cn(
                    'inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                    item.status === 'success'
                      ? isLight
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-emerald-500/15 text-emerald-400'
                      : isLight
                        ? 'bg-red-100 text-red-700'
                        : 'bg-red-500/15 text-red-400',
                  )}>
                  {item.status === 'success' ? <IconCheck /> : <IconXMark />}
                  {item.status === 'success' ? 'Done' : 'Fail'}
                </span>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className={cn('text-xs', sub)}>
                Showing {(safePage - 1) * ITEMS_PER_PAGE + 1}–{Math.min(safePage * ITEMS_PER_PAGE, items.length)} of{' '}
                {items.length}
              </p>
              <div className="flex items-center gap-1">
                <PaginationBtn onClick={() => goTo(safePage - 1)} disabled={safePage <= 1} isLight={isLight}>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </PaginationBtn>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <PaginationBtn key={p} onClick={() => goTo(p)} active={p === safePage} isLight={isLight}>
                    {p}
                  </PaginationBtn>
                ))}
                <PaginationBtn onClick={() => goTo(safePage + 1)} disabled={safePage >= totalPages} isLight={isLight}>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </PaginationBtn>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
