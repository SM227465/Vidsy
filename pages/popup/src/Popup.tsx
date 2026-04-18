import { Header } from './components/Header';
import { SettingCard, SettingRow } from './components/SettingCard';
import { SkeletonFallback, ErrorFallback } from './components/SkeletonFallback';
import { useMediaPage } from './hooks/useMediaPage';
import { withErrorBoundary, withSuspense, kindLabel, formatDate } from '@extension/shared';
import { exampleThemeStorage, mediaSettingsStorage } from '@extension/storage';
import {
  cn,
  BottomBar,
  DownloadRow,
  EmptyState,
  FilenameTemplateField,
  IconCheck,
  IconDownload,
  IconHistory,
  IconMoon,
  IconSidePanel,
  IconSun,
  IconTrash,
  IconExternal,
  IconVideo,
  IconX,
  IconXCircle,
  MediaCard,
  SkeletonCard,
  Toggle,
} from '@extension/ui';

const Popup = () => {
  const {
    currentMedia,
    isLoading,
    downloadState,
    setDownloadState,
    selectedVariants,
    setSelectedVariants,
    view,
    setView,
    moreMenuId,
    setMoreMenuId,
    editingId,
    setEditingId,
    editName,
    setEditName,
    downloads,
    settings,
    history,
    isLight,
    onDownload,
    onCancel,
    onPause,
    onRetry,
    onClearDownloads,
    clearTabDetections,
    copyUrl,
    startEdit,
    toggleHlsMerge,
    clearHistory,
    bg,
    text,
    textMuted,
    hoverBg,
  } = useMediaPage();

  const downloadList = Object.values(downloads).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const ACTIVE_STAGES = new Set(['init', 'fetch-manifest', 'download-video', 'download-audio', 'mux', 'finalize']);
  const activeDownloadCount = downloadList.filter(d => ACTIVE_STAGES.has(d.stage)).length;
  const hasTerminalEntries = downloadList.some(d => !ACTIVE_STAGES.has(d.stage));

  const popupActions = (
    <>
      <button
        className={cn(
          'rounded-lg p-2 transition',
          isLight
            ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
            : 'text-gray-500 hover:bg-white/[0.06] hover:text-gray-300',
        )}
        title="Toggle theme"
        onClick={exampleThemeStorage.toggle}>
        {isLight ? <IconMoon /> : <IconSun />}
      </button>
      <button
        className={cn(
          'rounded-lg p-2 transition',
          isLight
            ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
            : 'text-gray-500 hover:bg-white/[0.06] hover:text-gray-300',
        )}
        title="Side Panel"
        onClick={() => chrome.sidePanel?.open?.({ windowId: chrome.windows?.WINDOW_ID_CURRENT })}>
        <IconSidePanel />
      </button>
      <button
        className={cn(
          'rounded-lg p-2 transition',
          isLight
            ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
            : 'text-gray-500 hover:bg-white/[0.06] hover:text-gray-300',
        )}
        title="Options"
        onClick={() => chrome.runtime.openOptionsPage()}>
        <IconExternal />
      </button>
      <button
        className={cn(
          'rounded-lg p-2 transition',
          isLight
            ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
            : 'text-gray-500 hover:bg-white/[0.06] hover:text-gray-300',
        )}
        title="Clear detections"
        onClick={clearTabDetections}>
        <IconTrash />
      </button>
    </>
  );

  /* ── Settings View ─────────────────────────────── */
  if (view === 'settings') {
    return (
      <div className={cn('flex w-[380px] flex-1 flex-col font-sans', bg, text)}>
        <Header title="Settings" isLight={isLight} onBack={() => setView('main')} />

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <SettingCard isLight={isLight}>
            <SettingRow
              title="Merge DASH streams"
              subtitle="Combine video + audio tracks (HLS always merges)"
              isLight={isLight}>
              <Toggle checked={settings?.enableHlsMerging ?? false} onChange={toggleHlsMerge} isLight={isLight} />
            </SettingRow>
          </SettingCard>
          <SettingCard isLight={isLight}>
            <FilenameTemplateField
              value={settings?.filenameTemplate ?? ''}
              onChange={next => mediaSettingsStorage.set(prev => ({ ...prev, filenameTemplate: next }))}
              isLight={isLight}
            />
          </SettingCard>
        </div>

        <BottomBar
          isLight={isLight}
          view="settings"
          onViewChange={setView}
          actions={popupActions}
          mediaCount={currentMedia.length}
          downloadCount={activeDownloadCount}
          compact
        />
      </div>
    );
  }

  /* ── Downloads View ────────────────────────────── */
  if (view === 'downloads') {
    return (
      <div className={cn('flex w-[380px] flex-1 flex-col font-sans', bg, text)}>
        <Header
          title="Downloads"
          isLight={isLight}
          onBack={() => setView('main')}
          action={
            hasTerminalEntries ? (
              <button
                onClick={() => onClearDownloads()}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                  isLight ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-500/10',
                )}>
                Clear finished
              </button>
            ) : null
          }
        />

        <div className="flex-1 overflow-y-auto">
          {downloadList.length === 0 ? (
            <EmptyState
              icon={<IconDownload />}
              title="No active downloads"
              subtitle="Downloads in progress will appear here"
              isLight={isLight}
              className="py-20"
            />
          ) : (
            <div className="space-y-px">
              {downloadList.map(entry => (
                <DownloadRow
                  key={entry.key}
                  entry={entry}
                  isLight={isLight}
                  onRetry={onRetry}
                  onPause={onPause}
                  onCancel={onCancel}
                  onRemove={k => onClearDownloads([k])}
                />
              ))}
            </div>
          )}
        </div>

        <BottomBar
          isLight={isLight}
          view="downloads"
          onViewChange={setView}
          actions={popupActions}
          mediaCount={currentMedia.length}
          downloadCount={activeDownloadCount}
          compact
        />
      </div>
    );
  }

  /* ── History View ──────────────────────────────── */
  if (view === 'history') {
    return (
      <div className={cn('flex w-[380px] flex-1 flex-col font-sans', bg, text)}>
        <Header
          title="History"
          isLight={isLight}
          onBack={() => setView('main')}
          action={
            history.length > 0 ? (
              <button
                onClick={clearHistory}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                  isLight ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-500/10',
                )}>
                Clear all
              </button>
            ) : null
          }
        />

        <div className="flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <EmptyState
              icon={<IconHistory />}
              title="No downloads yet"
              subtitle="Your download history will appear here"
              isLight={isLight}
              className="py-20"
            />
          ) : (
            <div className="space-y-px px-2 py-2">
              {history.map(item => (
                <button
                  key={item.id}
                  className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition', hoverBg)}
                  onClick={() => onDownload(item)}>
                  <div
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                      item.status === 'success'
                        ? isLight
                          ? 'bg-emerald-100 text-emerald-600'
                          : 'bg-emerald-500/15 text-emerald-400'
                        : isLight
                          ? 'bg-red-100 text-red-600'
                          : 'bg-red-500/15 text-red-400',
                    )}>
                    {item.status === 'success' ? <IconCheck /> : <IconXCircle />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={cn('truncate text-xs font-medium', text)}>
                      {item.title ?? item.fileName ?? item.url}
                    </p>
                    <p className={cn('text-[10px]', textMuted)}>
                      {kindLabel(item.kind)} &middot; {formatDate(item.downloadedAt)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <BottomBar
          isLight={isLight}
          view="history"
          onViewChange={setView}
          actions={popupActions}
          mediaCount={currentMedia.length}
          downloadCount={activeDownloadCount}
          compact
        />
      </div>
    );
  }

  /* ── Main View ─────────────────────────────────── */
  return (
    <div className={cn('flex w-[380px] flex-1 flex-col font-sans', bg, text)}>
      {/* Error toast */}
      {downloadState.error ? (
        <div
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-xs font-medium',
            isLight ? 'bg-red-50 text-red-700' : 'bg-red-500/10 text-red-400',
          )}>
          <span className="flex-1">{downloadState.error}</span>
          <button
            onClick={() => setDownloadState(s => ({ ...s, error: null }))}
            className="opacity-60 hover:opacity-100">
            <IconX />
          </button>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-px">
            <SkeletonCard isLight={isLight} />
            <SkeletonCard isLight={isLight} />
          </div>
        ) : currentMedia.length === 0 ? (
          <EmptyState
            icon={<IconVideo />}
            title="No media detected"
            subtitle="Play a video or audio on this page to capture it"
            isLight={isLight}
            className="py-20"
          />
        ) : (
          <div className="space-y-px">
            {currentMedia.map(item => (
              <MediaCard
                key={item.id}
                item={item}
                isLight={isLight}
                downloadState={downloadState}
                downloads={downloads}
                selectedVariants={selectedVariants}
                setSelectedVariants={setSelectedVariants}
                settings={settings}
                moreMenuId={moreMenuId}
                setMoreMenuId={setMoreMenuId}
                editingId={editingId}
                setEditingId={setEditingId}
                editName={editName}
                setEditName={setEditName}
                onDownload={onDownload}
                onCancel={onCancel}
                startEdit={startEdit}
                copyUrl={copyUrl}
                onDismiss={clearTabDetections}
                textMuted={textMuted}
              />
            ))}
          </div>
        )}
      </div>

      <BottomBar
        isLight={isLight}
        view="main"
        onViewChange={setView}
        actions={popupActions}
        mediaCount={currentMedia.length}
        downloadCount={activeDownloadCount}
        compact
      />
    </div>
  );
};

export default withErrorBoundary(withSuspense(Popup, <SkeletonFallback />), ErrorFallback);
