import { SkeletonCard } from '@extension/ui';

export const SkeletonFallback = () => (
  <div className="flex min-h-screen w-full flex-col bg-[#0f1117] font-sans text-gray-100">
    <div className="flex items-center border-b border-white/[0.06] px-4 py-3">
      <div className="h-4 w-28 animate-pulse rounded bg-white/[0.06]" />
    </div>
    <div className="flex-1 space-y-px">
      <SkeletonCard isLight={false} />
      <SkeletonCard isLight={false} />
    </div>
    <div className="flex items-center justify-around border-t border-white/[0.06] px-2 py-2.5">
      {[1, 2, 3].map(i => (
        <div key={i} className="h-8 w-14 animate-pulse rounded-lg bg-white/[0.06]" />
      ))}
    </div>
  </div>
);

export const ErrorFallback = ({ error }: { error: Error; resetErrorBoundary?: () => void }) => (
  <div className="flex min-h-screen w-full flex-col items-center justify-center gap-2 bg-[#0f1117] font-sans text-gray-100">
    <p className="text-sm font-medium text-red-400">Something went wrong</p>
    <p className="text-xs text-gray-500">{error.message}</p>
  </div>
);
