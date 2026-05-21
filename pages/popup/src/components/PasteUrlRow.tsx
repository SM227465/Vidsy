import { MEDIA_MESSAGE } from '@extension/shared';
import { cn } from '@extension/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PasteUrlResult } from '@extension/shared';

export const PasteUrlRow = ({
  isLight,
  tabId,
  onClose,
}: {
  isLight: boolean;
  tabId: number | null;
  onClose: () => void;
}) => {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(async () => {
    const url = value.trim();
    if (!url || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result: PasteUrlResult = await chrome.runtime.sendMessage({
        type: MEDIA_MESSAGE.PASTE_URL,
        payload: { url, tabId: tabId ?? undefined },
      });
      if (result?.ok) {
        setValue('');
        onClose();
      } else {
        setError(result?.error ?? 'Could not add this URL');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add this URL');
    } finally {
      setBusy(false);
    }
  }, [value, busy, tabId, onClose]);

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 border-b px-3 py-2.5',
        isLight ? 'border-gray-100 bg-gray-50' : 'border-white/[0.04] bg-white/[0.02]',
      )}>
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="url"
          placeholder="Paste a video URL…"
          value={value}
          onChange={e => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') void submit();
            else if (e.key === 'Escape') onClose();
          }}
          disabled={busy}
          className={cn(
            'flex-1 rounded-md border px-2.5 py-1.5 text-[11px] outline-none transition',
            isLight
              ? 'border-gray-200 bg-white text-gray-800 placeholder:text-gray-400 focus:border-blue-300'
              : 'border-white/[0.08] bg-black/30 text-gray-100 placeholder:text-gray-500 focus:border-blue-500/50',
          )}
        />
        <button
          onClick={submit}
          disabled={busy || !value.trim()}
          className={cn(
            'shrink-0 rounded-md px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition',
            'bg-blue-500 shadow-blue-500/25 hover:bg-blue-600 active:scale-[0.97]',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button
          onClick={onClose}
          disabled={busy}
          className={cn(
            'shrink-0 rounded-md px-2 py-1.5 text-[11px] font-medium transition',
            isLight
              ? 'text-gray-500 hover:bg-gray-200 hover:text-gray-700'
              : 'text-gray-400 hover:bg-white/[0.06] hover:text-gray-200',
          )}>
          Cancel
        </button>
      </div>
      {error ? (
        <p className={cn('text-[10px] font-medium', isLight ? 'text-red-600' : 'text-red-400')}>{error}</p>
      ) : null}
    </div>
  );
};
