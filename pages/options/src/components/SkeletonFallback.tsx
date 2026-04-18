export const SkeletonFallback = () => (
  <div className="flex min-h-screen bg-[#0c0d12] font-sans text-gray-100">
    <aside className="fixed left-0 top-0 flex h-screen w-[220px] flex-col border-r border-white/[0.06] bg-[#111318]">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="h-8 w-8 animate-pulse rounded-lg bg-white/[0.06]" />
        <div className="h-4 w-24 animate-pulse rounded bg-white/[0.06]" />
      </div>
      <div className="mt-4 space-y-1 px-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-10 animate-pulse rounded-xl bg-white/[0.04]" />
        ))}
      </div>
    </aside>
    <main className="ml-[220px] flex-1 px-10 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="h-6 w-40 animate-pulse rounded bg-white/[0.06]" />
        <div className="h-4 w-64 animate-pulse rounded bg-white/[0.04]" />
        <div className="h-64 animate-pulse rounded-2xl bg-white/[0.03]" />
      </div>
    </main>
  </div>
);

export const ErrorFallback = ({ error }: { error: Error; resetErrorBoundary?: () => void }) => (
  <div className="flex min-h-screen items-center justify-center bg-[#0c0d12] font-sans text-gray-100">
    <div className="text-center">
      <p className="text-sm font-medium text-red-400">Something went wrong</p>
      <p className="mt-1 text-xs text-gray-500">{error.message}</p>
    </div>
  </div>
);
