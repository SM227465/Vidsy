import { cn } from '@extension/ui';

export const Header = ({
  title,
  isLight,
  onBack,
  action,
}: {
  title: string;
  isLight: boolean;
  onBack: () => void;
  action?: React.ReactNode;
}) => (
  <div
    className={cn(
      'flex items-center gap-2 px-4 py-2.5',
      isLight ? 'border-b border-gray-200' : 'border-b border-white/[0.06]',
    )}>
    <button
      onClick={onBack}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-lg transition',
        isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-white/[0.06]',
      )}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
    <span className="text-sm font-semibold">{title}</span>
    <div className="flex-1" />
    {action}
  </div>
);
