import { cn } from '../../utils';

export const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn('animate-pulse rounded', className)} />
);

export const SkeletonCard = ({ isLight }: { isLight: boolean }) => (
  <div className="flex gap-3 px-4 py-3">
    <Skeleton className={cn('h-[68px] w-[100px] shrink-0 rounded-lg', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')} />
    <div className="flex flex-1 flex-col justify-between py-0.5">
      <div className="space-y-2">
        <Skeleton className={cn('h-3.5 w-4/5 rounded', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')} />
        <Skeleton className={cn('h-3 w-3/5 rounded', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')} />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className={cn('h-5 w-10 rounded', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')} />
        <Skeleton className={cn('h-5 w-12 rounded', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')} />
        <div className="flex-1" />
        <Skeleton className={cn('h-7 w-20 rounded-full', isLight ? 'bg-gray-200' : 'bg-white/[0.06]')} />
      </div>
    </div>
  </div>
);
