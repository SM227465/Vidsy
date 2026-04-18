import { exampleThemeStorage } from '@extension/storage';
import { cn } from '@extension/ui';

type Tab = 'settings' | 'history' | 'about';

const IconSettings = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconHistory = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </svg>
);

const IconInfo = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
);

const IconSun = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

const IconMoon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const navItems: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
  { id: 'history', label: 'History', icon: <IconHistory /> },
  { id: 'about', label: 'About', icon: <IconInfo /> },
];

export const Sidebar = ({
  isLight,
  activeTab,
  setActiveTab,
}: {
  isLight: boolean;
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
}) => {
  const sidebarBg = isLight ? 'bg-white border-r border-gray-200' : 'bg-[#111318] border-r border-white/[0.06]';
  const text = isLight ? 'text-gray-800' : 'text-gray-100';

  return (
    <aside className={cn('fixed left-0 top-0 flex h-screen w-[220px] flex-col', sidebarBg)}>
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-lg text-sm',
            isLight ? 'bg-blue-100' : 'bg-blue-500/15',
          )}>
          🎬
        </div>
        <span className={cn('text-sm font-bold tracking-tight', text)}>Vidsy</span>
      </div>

      {/* Nav */}
      <nav className="mt-2 flex-1 space-y-0.5 px-3">
        {navItems.map(item => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] font-medium transition',
                active
                  ? isLight
                    ? 'bg-blue-50 text-blue-600'
                    : 'bg-blue-500/10 text-blue-400'
                  : isLight
                    ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                    : 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200',
              )}>
              <span className={active ? '' : 'opacity-60'}>{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className={cn('border-t px-5 py-4', isLight ? 'border-gray-200' : 'border-white/[0.06]')}>
        <button
          onClick={exampleThemeStorage.toggle}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition',
            isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-white/[0.04]',
          )}>
          {isLight ? <IconMoon /> : <IconSun />}
          {isLight ? 'Dark mode' : 'Light mode'}
        </button>
      </div>
    </aside>
  );
};
