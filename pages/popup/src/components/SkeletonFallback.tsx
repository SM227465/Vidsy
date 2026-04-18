import { cn } from '@extension/ui';
import { SkeletonCard, Skeleton } from '@extension/ui';

export const SkeletonFallback = () => {
  const isLight = false; // default to dark during initial load
  return (
    <div className={cn('flex w-[380px] flex-1 flex-col font-sans', 'bg-[#0f1117] text-gray-100')}>
      <div className="flex-1 space-y-px">
        <SkeletonCard isLight={isLight} />
        <SkeletonCard isLight={isLight} />
        <SkeletonCard isLight={isLight} />
      </div>
      <div className="mt-auto flex items-center justify-around border-t border-white/[0.06] px-2 py-2.5">
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-8 w-14 rounded-lg bg-white/[0.06]" />
        ))}
      </div>
    </div>
  );
};

export const ErrorFallback = ({ error }: { error: Error; resetErrorBoundary?: () => void }) => (
  <div className="flex w-[380px] flex-1 flex-col items-center justify-center gap-2 bg-[#0f1117] px-6 py-20 text-center font-sans text-gray-100">
    <p className="text-sm font-medium text-red-400">Something went wrong</p>
    <p className="text-xs text-gray-500">{error.message}</p>
  </div>
);
