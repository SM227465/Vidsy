import { cn } from '@extension/ui';

export const SettingCard = ({ children, isLight }: { children: React.ReactNode; isLight: boolean }) => (
  <div
    className={cn(
      'rounded-xl border p-1',
      isLight ? 'border-gray-200 bg-white' : 'border-white/[0.06] bg-white/[0.02]',
    )}>
    {children}
  </div>
);

export const SettingRow = ({
  title,
  subtitle,
  children,
  isLight,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  isLight: boolean;
}) => (
  <div className={cn('flex items-center justify-between gap-4 rounded-lg px-3 py-3')}>
    <div>
      <p className={cn('text-xs font-medium', isLight ? 'text-gray-800' : 'text-gray-200')}>{title}</p>
      <p className={cn('mt-0.5 text-[11px]', isLight ? 'text-gray-400' : 'text-gray-500')}>{subtitle}</p>
    </div>
    {children}
  </div>
);
