import { cn } from '../../utils';

export const Toggle = ({ checked, onChange, isLight }: { checked: boolean; onChange: () => void; isLight?: boolean }) => (
  <button
    onClick={onChange}
    className={cn(
      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
      checked ? 'bg-blue-500' : isLight ? 'bg-gray-300' : 'bg-gray-600',
    )}>
    <span
      className={cn(
        'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
        checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
      )}
    />
  </button>
);
