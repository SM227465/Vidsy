import { IconX } from './icons';
import { cn } from '../../utils';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

const QRCodeSVG = lazy(() => import('qrcode.react').then(m => ({ default: m.QRCodeSVG })));

const truncateMiddle = (s: string, max = 56): string => {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
};

const MAX_QR_URL_LENGTH = 2000;

export const QrCodeModal = ({
  open,
  url,
  title,
  onClose,
  isLight,
}: {
  open: boolean;
  url: string;
  title?: string;
  onClose: () => void;
  isLight: boolean;
}) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(url).then(
      () => setCopied(true),
      () => undefined,
    );
  }, [url]);

  if (!open) return null;

  const tooLong = url.length > MAX_QR_URL_LENGTH;

  return (
    <div role="dialog" aria-modal="true" aria-label="Share to mobile" className="fixed inset-0 z-[100] p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
      />
      <div className="relative flex h-full items-center justify-center">
        <div
          className={cn(
            'relative w-full max-w-[320px] rounded-2xl border p-5 shadow-xl',
            isLight ? 'border-gray-200 bg-white' : 'border-white/[0.08] bg-[#1a1d24]',
          )}>
          <button
            onClick={onClose}
            className={cn(
              'absolute right-3 top-3 rounded-md p-1 transition',
              isLight
                ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700'
                : 'text-gray-500 hover:bg-white/[0.06] hover:text-gray-200',
            )}
            title="Close">
            <IconX />
          </button>

          <h3 className={cn('mb-1 text-sm font-semibold', isLight ? 'text-gray-800' : 'text-gray-100')}>
            Share to mobile
          </h3>
          <p className={cn('mb-4 text-xs', isLight ? 'text-gray-500' : 'text-gray-400')}>
            Scan with your phone to open this URL.
          </p>

          {tooLong ? (
            <div
              className={cn(
                'mb-3 rounded-lg px-3 py-2 text-xs',
                isLight ? 'bg-amber-50 text-amber-700' : 'bg-amber-500/10 text-amber-300',
              )}>
              URL is too long to encode as a QR. Copy the link instead.
            </div>
          ) : (
            <div className="mb-4 flex justify-center">
              <div className="rounded-xl bg-white p-3">
                <Suspense fallback={<div className="h-[200px] w-[200px] animate-pulse rounded bg-gray-100" />}>
                  <QRCodeSVG value={url} size={200} level="M" />
                </Suspense>
              </div>
            </div>
          )}

          {title ? (
            <p
              className={cn('mb-1 truncate text-xs font-medium', isLight ? 'text-gray-700' : 'text-gray-300')}
              title={title}>
              {title}
            </p>
          ) : null}

          <button
            onClick={onCopy}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[11px] font-medium transition',
              isLight
                ? 'border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300 hover:bg-gray-100'
                : 'border-white/[0.06] bg-white/[0.03] text-gray-300 hover:border-white/[0.12] hover:bg-white/[0.06]',
            )}
            title="Click to copy">
            <span className="truncate font-mono">{truncateMiddle(url)}</span>
            <span className={cn('shrink-0', copied ? 'text-emerald-500' : 'opacity-60')}>
              {copied ? 'Copied' : 'Copy'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
