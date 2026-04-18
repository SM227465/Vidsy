import type { MediaItem, MediaDownloadProgress } from '@extension/shared';
import { GLASS, GLASS_BORDER, BLUR, TEXT, MUTED, HOVER } from './tokens';
import { IcoDown, IcoStop, IcoChev, IcoX } from './icons';
import { SpinnerDots } from './SpinnerDots';

export const PillBar = ({
  primary,
  isBusy,
  prog,
  pct,
  bestUrl,
  bestQLabel,
  open,
  stageShort,
  onMainClick,
  onToggleOpen,
  onDismiss,
}: {
  primary: MediaItem;
  isBusy: boolean;
  prog: MediaDownloadProgress | null;
  pct: number | null;
  bestUrl: string;
  bestQLabel: string;
  open: boolean;
  stageShort: Record<string, string>;
  onMainClick: () => void;
  onToggleOpen: () => void;
  onDismiss: () => void;
}) => (
  <div
    style={{
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'stretch',
      background: GLASS,
      backdropFilter: BLUR,
      WebkitBackdropFilter: BLUR,
      border: `1px solid ${GLASS_BORDER}`,
      borderRadius: open && !isBusy ? '10px 10px 0 0' : 10,
      overflow: 'hidden',
      boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
      whiteSpace: 'nowrap',
      userSelect: 'none',
    }}>
    {/* Main area (1-Click Download) */}
    <button
      onClick={e => {
        e.stopPropagation();
        onMainClick();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: prog?.stage === 'failed' ? '#f87171' : prog?.stage === 'success' ? '#86efac' : TEXT,
        padding: isBusy && pct !== null ? '6px 6px 6px 10px' : '5px 4px 5px 10px',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.1,
      }}
      onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = HOVER)}
      onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'none')}>
      {/* Icon */}
      {isBusy && !['success', 'failed'].includes(prog?.stage ?? '') ? <IcoStop /> : <IcoDown />}

      {/* Label with percentage */}
      {isBusy ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: TEXT }}>{stageShort[prog?.stage ?? ''] ?? prog?.stage ?? 'Downloading'}</span>
          {pct !== null && (
            <span
              style={{
                color: MUTED,
                fontSize: 11,
                fontWeight: 600,
              }}>
              {pct}%
            </span>
          )}
        </div>
      ) : (
        <span>Download</span>
      )}

      {/* Badge: quality label or spinner */}
      {isBusy && pct === null ? (
        <SpinnerDots />
      ) : !isBusy && bestQLabel ? (
        <span
          style={{
            background: 'rgba(255,255,255,0.10)',
            color: 'rgba(255,255,255,0.65)',
            borderRadius: 4,
            fontSize: 9.5,
            fontWeight: 700,
            padding: '1px 5px',
          }}>
          {bestQLabel}
        </span>
      ) : null}
    </button>

    {/* Chevron Dropdown Toggle (Idle only) */}
    {!isBusy && (
      <button
        onClick={e => {
          e.stopPropagation();
          onToggleOpen();
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: TEXT,
          padding: '5px 8px 5px 4px',
        }}
        onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = HOVER)}
        onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'none')}>
        <IcoChev open={open} />
      </button>
    )}

    {/* Divider */}
    <div style={{ width: 1, background: GLASS_BORDER, alignSelf: 'stretch', flexShrink: 0 }} />

    {/* Close */}
    <button
      onClick={e => {
        e.stopPropagation();
        onDismiss();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: 'rgba(255,255,255,0.7)',
        padding: '5px 8px',
        minWidth: 28,
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = 'rgba(239,68,68,0.15)';
        (e.currentTarget as HTMLElement).style.color = '#f87171';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = 'none';
        (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.7)';
      }}
      title="Close">
      <IcoX />
    </button>

    {/* Integrated progress bar at very bottom of pill (inside overflow:hidden) */}
    {isBusy && pct !== null && (
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: `${pct}%`,
          height: 2,
          background: prog?.stage === 'mux' ? '#fbbf24' : '#60a5fa',
          transition: 'width 0.4s ease',
          zIndex: 2,
        }}
      />
    )}
  </div>
);
