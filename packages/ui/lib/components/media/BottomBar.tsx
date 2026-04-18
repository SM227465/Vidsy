import { IconVideo, IconHistory, IconSettings, IconDownload } from './icons';
import { cn } from '../../utils';

export type BottomBarView = 'main' | 'settings' | 'history' | 'downloads';

export const BottomBar = ({
  isLight,
  view,
  onViewChange,
  actions,
  borderB,
  mediaCount,
  downloadCount,
  compact = false,
}: {
  isLight: boolean;
  view: BottomBarView;
  onViewChange: (v: BottomBarView) => void;
  actions?: React.ReactNode;
  borderB?: string;
  mediaCount?: number;
  downloadCount?: number;
  compact?: boolean;
}) => {
  const active = (v: string) => view === v;
  const btnCls = (v: string) =>
    cn(
      'flex items-center rounded-lg font-medium transition',
      compact ? 'gap-1 px-2 py-1.5 text-[10px]' : 'flex-col gap-0.5 px-3 py-1.5 text-[10px]',
      active(v)
        ? isLight
          ? 'bg-blue-50 text-blue-600'
          : 'bg-blue-500/10 text-blue-400'
        : isLight
          ? 'text-gray-400 hover:text-gray-600'
          : 'text-gray-500 hover:text-gray-300',
    );

  const mediaBadge = mediaCount && mediaCount > 0 ? mediaCount : null;
  const downloadBadge = downloadCount && downloadCount > 0 ? downloadCount : null;

  return (
    <div
      className={cn(
        'mt-auto flex shrink-0 items-center justify-around border-t px-2 py-1',
        borderB ? `border-${borderB}` : isLight ? 'border-gray-200 bg-white' : 'border-white/[0.06] bg-[#0f1117]',
      )}>
      <button className={btnCls('main')} onClick={() => onViewChange('main')} title="Media">
        <IconVideo />
        {compact ? (
          mediaBadge ? (
            <span className="tabular-nums">{mediaBadge}</span>
          ) : null
        ) : (
          <span>Media{mediaBadge ? ` (${mediaBadge})` : ''}</span>
        )}
      </button>
      <button className={btnCls('downloads')} onClick={() => onViewChange('downloads')} title="Downloads">
        <IconDownload />
        {compact ? (
          downloadBadge ? (
            <span className="tabular-nums">{downloadBadge}</span>
          ) : null
        ) : (
          <span>Downloads{downloadBadge ? ` (${downloadBadge})` : ''}</span>
        )}
      </button>
      {!compact ? (
        <>
          <button className={btnCls('history')} onClick={() => onViewChange('history')} title="History">
            <IconHistory />
            <span>History</span>
          </button>
          <button className={btnCls('settings')} onClick={() => onViewChange('settings')} title="Settings">
            <IconSettings />
            <span>Settings</span>
          </button>
        </>
      ) : null}
      {actions ? (
        <>
          <div className={cn('h-5 w-px', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')} />
          {actions}
        </>
      ) : null}
    </div>
  );
};
