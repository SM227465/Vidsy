import { PanelHeader } from './components/PanelHeader';
import { SkeletonFallback, ErrorFallback } from './components/SkeletonFallback';
import { useMediaPage } from './hooks/useMediaPage';
import { withErrorBoundary, withSuspense, mediaBadgeLabel, formatDate } from '@extension/shared';
import { mediaSettingsStorage, mediaHistoryStorage, exampleThemeStorage } from '@extension/storage';
import {
  cn,
  BottomBar,
  DownloadRow,
  EmptyState,
  FilenameTemplateField,
  IconCheck,
  IconDownload,
  IconHistory,
  IconTrash,
  IconVideo,
  IconX,
  IconXCircle,
  MediaCard,
  SkeletonCard,
  Toggle,
} from '@extension/ui';

const SidePanel = () => {
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
    forceDetecting,
    forceDetectDone,
    onDownload,
    onCancel,
    onPause,
    onRetry,
    onClearDownloads,
    clearTabDetections,
    forceDetect,
    copyUrl,
    startEdit,
    bg,
    text,
    textMuted,
    borderB,
    hoverBg,
  } = useMediaPage();

  const downloadList = Object.values(downloads).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const ACTIVE_STAGES = new Set(['init', 'fetch-manifest', 'download-video', 'download-audio', 'mux', 'finalize']);
  const activeDownloadCount = downloadList.filter(d => ACTIVE_STAGES.has(d.stage)).length;
  const hasTerminalEntries = downloadList.some(d => !ACTIVE_STAGES.has(d.stage));

  const sidePanelActions = (
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
  );

  /* ── Settings View ─── */
  if (view === 'settings') {
    return (
      <div className={cn('flex min-h-screen w-full flex-col font-sans', bg, text)}>
        <PanelHeader title="Settings" isLight={isLight} onBack={() => setView('main')} />
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <div
            className={cn(
              'rounded-xl border p-1',
              isLight ? 'border-gray-200 bg-white' : 'border-white/[0.06] bg-white/[0.02]',
            )}>
            <div className="flex items-center justify-between rounded-lg px-3 py-3">
              <div>
                <p className={cn('text-xs font-medium', isLight ? 'text-gray-800' : 'text-gray-200')}>
                  Merge DASH streams
                </p>
                <p className={cn('mt-0.5 text-[11px]', textMuted)}>Combine video + audio tracks</p>
              </div>
              <Toggle
                checked={settings?.enableHlsMerging ?? false}
                onChange={() => mediaSettingsStorage.set(p => ({ ...p, enableHlsMerging: !p.enableHlsMerging }))}
                isLight={isLight}
              />
            </div>
          </div>
          <div
            className={cn(
              'rounded-xl border p-1',
              isLight ? 'border-gray-200 bg-white' : 'border-white/[0.06] bg-white/[0.02]',
            )}>
            <FilenameTemplateField
              value={settings?.filenameTemplate ?? ''}
              onChange={next => mediaSettingsStorage.set(prev => ({ ...prev, filenameTemplate: next }))}
              isLight={isLight}
            />
          </div>
        </div>
        <BottomBar
          isLight={isLight}
          view="settings"
          onViewChange={setView}
          actions={sidePanelActions}
          mediaCount={currentMedia.length}
          downloadCount={activeDownloadCount}
        />
      </div>
    );
  }

  /* ── Downloads View ─── */
  if (view === 'downloads') {
    return (
      <div className={cn('flex min-h-screen w-full flex-col font-sans', bg, text)}>
        <PanelHeader
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
              className="py-24"
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
          actions={sidePanelActions}
          mediaCount={currentMedia.length}
          downloadCount={activeDownloadCount}
        />
      </div>
    );
  }

  /* ── History View ─── */
  if (view === 'history') {
    return (
      <div className={cn('flex min-h-screen w-full flex-col font-sans', bg, text)}>
        <PanelHeader
          title="History"
          isLight={isLight}
          onBack={() => setView('main')}
          action={
            history.length > 0 ? (
              <button
                onClick={() => mediaHistoryStorage.set([])}
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
              subtitle="Download history will appear here"
              isLight={isLight}
              className="py-24"
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
                      {mediaBadgeLabel(item)} &middot; {formatDate(item.downloadedAt)}
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
          actions={sidePanelActions}
          mediaCount={currentMedia.length}
          downloadCount={activeDownloadCount}
        />
      </div>
    );
  }

  /* ── Main View ─── */
  return (
    <div className={cn('flex min-h-screen w-full flex-col font-sans', bg, text)}>
      {/* Header */}
      <div className={cn('flex items-center gap-2 border-b px-4 py-3', borderB, isLight ? 'bg-white' : 'bg-[#0f1117]')}>
        <span className={cn('text-sm font-bold tracking-tight', text)}>Video Downloader</span>
        {currentMedia.length > 0 ? (
          <span className="rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
            {currentMedia.length}
          </span>
        ) : null}
        <div className="flex-1" />
        {/* Force Detect button */}
        <button
          className={cn(
            'rounded-lg p-1.5 transition',
            forceDetectDone
              ? 'bg-emerald-500/15 text-emerald-400'
              : forceDetecting
                ? isLight
                  ? 'bg-gray-100 text-gray-400'
                  : 'bg-white/[0.06] text-gray-500'
                : isLight
                  ? 'text-gray-400 hover:bg-orange-50 hover:text-orange-500'
                  : 'text-gray-500 hover:bg-orange-500/10 hover:text-orange-400',
          )}
          onClick={forceDetect}
          title="Force scan page for videos">
          {forceDetecting ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="animate-spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : forceDetectDone ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          )}
        </button>
        <button
          className={cn(
            'rounded-lg p-1.5 transition',
            isLight
              ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
              : 'text-gray-500 hover:bg-white/[0.06] hover:text-gray-300',
          )}
          onClick={exampleThemeStorage.toggle}
          title="Toggle theme">
          {isLight ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          )}
        </button>
        <button
          className={cn(
            'rounded-lg p-1.5 transition',
            isLight
              ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
              : 'text-gray-500 hover:bg-white/[0.06] hover:text-gray-300',
          )}
          onClick={() => chrome.runtime.openOptionsPage()}
          title="Options">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
          </svg>
        </button>
        <button
          className={cn(
            'rounded-lg p-1.5 transition',
            isLight
              ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
              : 'text-gray-500 hover:bg-white/[0.06] hover:text-gray-300',
          )}
          onClick={() => setView('settings')}
          title="Settings">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>

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
            className="py-24"
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
              />
            ))}
          </div>
        )}
      </div>

      <BottomBar
        isLight={isLight}
        view="main"
        onViewChange={setView}
        actions={sidePanelActions}
        mediaCount={currentMedia.length}
        downloadCount={activeDownloadCount}
      />
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <SkeletonFallback />), ErrorFallback);
