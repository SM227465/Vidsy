import { Toggle } from './Toggle';
import { useStorage } from '@extension/shared';
import { mediaSettingsStorage, exampleThemeStorage } from '@extension/storage';
import { cn, FilenameTemplateField } from '@extension/ui';

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

const IconSun = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

const IconMoon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

export const SettingsPanel = ({ isLight }: { isLight: boolean }) => {
  const settings = useStorage(mediaSettingsStorage);

  const cardCls = cn(
    'rounded-2xl border',
    isLight ? 'border-gray-200 bg-white shadow-sm' : 'border-white/[0.06] bg-white/[0.02]',
  );
  const divider = cn('border-t', isLight ? 'border-gray-100' : 'border-white/[0.04]');
  const label = isLight ? 'text-gray-800' : 'text-gray-100';
  const sub = isLight ? 'text-gray-400' : 'text-gray-500';

  return (
    <div className="space-y-6">
      <div>
        <h2 className={cn('text-lg font-semibold', label)}>Preferences</h2>
        <p className={cn('mt-1 text-sm', sub)}>Customize how Vidsy works</p>
      </div>

      <div className={cardCls}>
        {/* Theme */}
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-xl',
                isLight ? 'bg-amber-100 text-amber-600' : 'bg-amber-500/10 text-amber-400',
              )}>
              {isLight ? <IconSun /> : <IconMoon />}
            </div>
            <div>
              <p className={cn('text-sm font-medium', label)}>Appearance</p>
              <p className={cn('text-xs', sub)}>Currently {isLight ? 'light' : 'dark'} mode</p>
            </div>
          </div>
          <Toggle checked={!isLight} onChange={exampleThemeStorage.toggle} isLight={isLight} />
        </div>

        <div className={divider} />

        {/* DASH Merge */}
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-xl',
                isLight ? 'bg-blue-100 text-blue-600' : 'bg-blue-500/10 text-blue-400',
              )}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            </div>
            <div>
              <p className={cn('text-sm font-medium', label)}>DASH stream merging</p>
              <p className={cn('text-xs', sub)}>Merge video + audio tracks (HLS always merges)</p>
            </div>
          </div>
          <Toggle
            checked={settings?.enableHlsMerging ?? false}
            onChange={() => mediaSettingsStorage.set(prev => ({ ...prev, enableHlsMerging: !prev.enableHlsMerging }))}
            isLight={isLight}
          />
        </div>

        <div className={divider} />

        {/* History limit */}
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-xl',
                isLight ? 'bg-violet-100 text-violet-600' : 'bg-violet-500/10 text-violet-400',
              )}>
              <IconHistory />
            </div>
            <div>
              <p className={cn('text-sm font-medium', label)}>History limit</p>
              <p className={cn('text-xs', sub)}>Max downloads to keep in history</p>
            </div>
          </div>
          <select
            value={settings?.maxHistory ?? 30}
            onChange={e => mediaSettingsStorage.set(prev => ({ ...prev, maxHistory: Number(e.target.value) }))}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-sm font-medium outline-none transition',
              isLight
                ? 'border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300'
                : 'border-white/[0.08] bg-white/[0.04] text-gray-300 hover:border-white/[0.15]',
            )}>
            <option value={10}>10</option>
            <option value={30}>30</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </div>
      </div>

      <div className={cn(cardCls, 'p-5')}>
        <FilenameTemplateField
          value={settings?.filenameTemplate ?? ''}
          onChange={next => mediaSettingsStorage.set(prev => ({ ...prev, filenameTemplate: next }))}
          isLight={isLight}
        />
      </div>
    </div>
  );
};
