import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage } from '@extension/storage';
import { cn } from '@extension/ui';
import { useState } from 'react';
import { SettingsPanel } from './components/SettingsPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { AboutPanel } from './components/AboutPanel';
import { Sidebar } from './components/Sidebar';
import { SkeletonFallback, ErrorFallback } from './components/SkeletonFallback';

type Tab = 'settings' | 'history' | 'about';

const Options = () => {
  const { isLight } = useStorage(exampleThemeStorage);
  const [activeTab, setActiveTab] = useState<Tab>('settings');

  const bg = isLight ? 'bg-gray-50' : 'bg-[#0c0d12]';
  const text = isLight ? 'text-gray-800' : 'text-gray-100';

  return (
    <div className={cn('flex min-h-screen font-sans antialiased', bg, text)}>
      <Sidebar isLight={isLight} activeTab={activeTab} setActiveTab={setActiveTab} />

      {/* Content */}
      <main className="ml-[220px] flex-1 px-10 py-8">
        <div className="mx-auto max-w-3xl">
          {activeTab === 'settings' && <SettingsPanel isLight={isLight} />}
          {activeTab === 'history' && <HistoryPanel isLight={isLight} />}
          {activeTab === 'about' && <AboutPanel isLight={isLight} />}
        </div>
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <SkeletonFallback />), ErrorFallback);
