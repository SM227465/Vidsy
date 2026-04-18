import { cn } from '@extension/ui';

export const Toggle = ({ checked, onChange, isLight }: { checked: boolean; onChange: () => void; isLight: boolean }) => (
  <button
    onClick={onChange}
    className={cn(
      'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors',
      checked ? 'bg-blue-500' : isLight ? 'bg-gray-300' : 'bg-gray-600',
    )}>
    <span
      className={cn(
        'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-6' : 'translate-x-1',
      )}
    />
  </button>
);
