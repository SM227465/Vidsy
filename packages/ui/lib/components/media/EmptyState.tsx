import { cn } from '../../utils';

export const EmptyState = ({
  icon,
  title,
  subtitle,
  isLight,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  isLight: boolean;
  className?: string;
}) => (
  <div className={cn('flex flex-col items-center justify-center gap-3 px-8 text-center', className)}>
    <div
      className={cn(
        'flex h-14 w-14 items-center justify-center rounded-2xl',
        isLight ? 'bg-gray-100 text-gray-400' : 'bg-white/[0.04] text-gray-600',
      )}>
      {icon}
    </div>
    <div>
      <p className={cn('text-sm font-medium', isLight ? 'text-gray-700' : 'text-gray-300')}>{title}</p>
      <p className={cn('mt-0.5 text-xs', isLight ? 'text-gray-400' : 'text-gray-500')}>{subtitle}</p>
    </div>
  </div>
);
