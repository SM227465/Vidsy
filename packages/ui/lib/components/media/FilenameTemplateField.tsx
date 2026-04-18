import { cn } from '../../utils';
import { buildFilenameContext, renderFilenameTemplate } from '@extension/shared';
import { useMemo } from 'react';

const EXAMPLE_ITEM = {
  title: 'Sample Video Title',
  kind: 'hls' as const,
  pageUrl: 'https://example.com/watch/123',
  url: 'https://cdn.example.com/stream.m3u8',
  variants: [{ url: '', resolution: { width: 1920, height: 1080 } }],
};

const TOKENS = [
  { token: '{title}', desc: 'Video title' },
  { token: '{resolution}', desc: 'e.g. 1080p' },
  { token: '{ext}', desc: 'mp4 / mp3' },
  { token: '{kind}', desc: 'video / hls / dash' },
  { token: '{host}', desc: 'Source domain' },
  { token: '{date}', desc: 'YYYY-MM-DD' },
];

export const FilenameTemplateField = ({
  value,
  onChange,
  isLight,
}: {
  value: string;
  onChange: (next: string) => void;
  isLight: boolean;
}) => {
  const preview = useMemo(() => {
    const ctx = buildFilenameContext(EXAMPLE_ITEM, { ext: 'mp4' });
    return renderFilenameTemplate(value, ctx);
  }, [value]);

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className={cn('text-xs font-medium', isLight ? 'text-gray-800' : 'text-gray-200')}>Filename template</p>
          <p className={cn('mt-0.5 text-[11px]', isLight ? 'text-gray-400' : 'text-gray-500')}>
            Leave blank to use auto-derived names
          </p>
        </div>
      </div>

      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="{title} - {resolution}"
        className={cn(
          'w-full rounded-md border px-2.5 py-1.5 text-[11px] font-medium outline-none transition',
          isLight
            ? 'border-gray-200 bg-white text-gray-800 focus:border-blue-400'
            : 'border-white/[0.08] bg-white/[0.04] text-gray-200 focus:border-blue-500/60',
        )}
      />

      <div className={cn('rounded-md px-2.5 py-1.5 text-[10px]', isLight ? 'bg-gray-50' : 'bg-white/[0.03]')}>
        <span className={cn('font-semibold', isLight ? 'text-gray-500' : 'text-gray-500')}>Preview: </span>
        <span className={cn('font-mono', isLight ? 'text-gray-700' : 'text-gray-300')}>
          {preview ? `${preview}.mp4` : <em className={cn(isLight ? 'text-gray-400' : 'text-gray-500')}>auto</em>}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {TOKENS.map(t => (
          <button
            key={t.token}
            type="button"
            onClick={() => onChange(value + (value && !value.endsWith(' ') ? ' ' : '') + t.token)}
            title={t.desc}
            className={cn(
              'rounded border px-1.5 py-0.5 font-mono text-[9px] transition',
              isLight
                ? 'border-gray-200 bg-gray-50 text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700'
                : 'border-white/[0.08] bg-white/[0.03] text-gray-400 hover:border-blue-500/40 hover:bg-blue-500/10 hover:text-blue-300',
            )}>
            {t.token}
          </button>
        ))}
      </div>
    </div>
  );
};
