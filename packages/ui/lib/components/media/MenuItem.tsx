import { cn } from '../../utils';

export const MenuItem = ({ label, onClick, isLight }: { label: string; onClick: () => void; isLight: boolean }) => (
  <button
    className={cn(
      'w-full px-3 py-1.5 text-left text-xs transition',
      isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:bg-white/[0.06]',
    )}
    onClick={onClick}>
    {label}
  </button>
);
