import { IcoDown, IcoStop, IcoChev, IcoX, IcoRecord, IcoPause, IcoResume } from './icons';
import { SpinnerDots } from './SpinnerDots';
import { GLASS, GLASS_BORDER, BLUR, TEXT, MUTED, HOVER } from './tokens';
import { formatBytes, formatSeconds } from '../lib/media-helpers';
import type { MediaDownloadProgress } from '@extension/shared';
import type { CSSProperties, MouseEvent } from 'react';

const containerStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'stretch',
  background: GLASS,
  backdropFilter: BLUR,
  WebkitBackdropFilter: BLUR,
  border: `1px solid ${GLASS_BORDER}`,
  borderRadius: 10,
  overflow: 'hidden',
  boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
  whiteSpace: 'nowrap',
  userSelect: 'none',
};

const iconBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: TEXT,
  padding: '5px 9px',
};

const divider: CSSProperties = { width: 1, background: GLASS_BORDER, alignSelf: 'stretch', flexShrink: 0 };

const hoverIn = (e: MouseEvent) => ((e.currentTarget as HTMLElement).style.background = HOVER);
const hoverOut = (e: MouseEvent) => ((e.currentTarget as HTMLElement).style.background = 'none');

const CloseButton = ({ onClick, title }: { onClick: () => void; title: string }) => (
  <button
    onClick={e => {
      e.stopPropagation();
      onClick();
    }}
    style={{ ...iconBtn, color: 'rgba(255,255,255,0.7)', padding: '5px 8px', minWidth: 28 }}
    onMouseEnter={e => {
      (e.currentTarget as HTMLElement).style.background = 'rgba(239,68,68,0.15)';
      (e.currentTarget as HTMLElement).style.color = '#f87171';
    }}
    onMouseLeave={e => {
      (e.currentTarget as HTMLElement).style.background = 'none';
      (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.7)';
    }}
    title={title}>
    <IcoX />
  </button>
);

export const PillBar = ({
  isBusy,
  prog,
  pct,
  bestUrl,
  bestQLabel,
  open,
  stageShort,
  isLive,
  elapsed,
  onMainClick,
  onToggleOpen,
  onDismiss,
  onRecord,
  onPauseResume,
  onStopRecord,
  onDiscardRecord,
}: {
  isBusy: boolean;
  prog: MediaDownloadProgress | null;
  pct: number | null;
  bestUrl: string;
  bestQLabel: string;
  open: boolean;
  stageShort: Record<string, string>;
  isLive: boolean;
  elapsed: number;
  onMainClick: () => void;
  onToggleOpen: () => void;
  onDismiss: () => void;
  onRecord: () => void;
  onPauseResume: () => void;
  onStopRecord: () => void;
  onDiscardRecord: () => void;
}) => {
  void bestUrl;
  const recStage = prog?.stage === 'recording' ? 'recording' : prog?.stage === 'recording-paused' ? 'paused' : null;

  // ─── Recording / paused ───
  if (recStage) {
    const paused = recStage === 'paused';
    return (
      <div style={containerStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            color: TEXT,
            fontSize: 11,
            fontWeight: 600,
          }}>
          <span style={{ color: paused ? MUTED : '#f87171', display: 'inline-flex' }}>
            <IcoRecord />
          </span>
          <span style={{ color: paused ? MUTED : TEXT }}>{paused ? 'Paused' : 'REC'}</span>
          <span style={{ color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{formatSeconds(elapsed) || '0:00'}</span>
          {prog?.downloadedBytes ? <span style={{ color: MUTED }}>{formatBytes(prog.downloadedBytes)}</span> : null}
        </div>
        <div style={divider} />
        <button
          onClick={e => {
            e.stopPropagation();
            onPauseResume();
          }}
          style={iconBtn}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
          title={paused ? 'Resume recording' : 'Pause recording'}>
          {paused ? <IcoResume /> : <IcoPause />}
        </button>
        <button
          onClick={e => {
            e.stopPropagation();
            onStopRecord();
          }}
          style={{ ...iconBtn, gap: 5, color: '#86efac', fontSize: 11, fontWeight: 600 }}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
          title="Stop and save">
          <IcoStop />
          <span>Stop</span>
        </button>
        <div style={divider} />
        <CloseButton onClick={onDiscardRecord} title="Discard recording" />
      </div>
    );
  }

  // ─── Live, idle → Record ───
  if (isLive && !isBusy) {
    return (
      <div style={containerStyle}>
        <button
          onClick={e => {
            e.stopPropagation();
            onRecord();
          }}
          style={{ ...iconBtn, gap: 5, padding: '5px 4px 5px 10px', fontSize: 11, fontWeight: 600 }}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}>
          <span style={{ color: '#f87171', display: 'inline-flex' }}>
            <IcoRecord />
          </span>
          <span>Record</span>
          <span
            style={{
              background: 'rgba(239,68,68,0.22)',
              color: '#fca5a5',
              borderRadius: 4,
              fontSize: 9.5,
              fontWeight: 700,
              padding: '1px 5px',
              letterSpacing: 0.3,
            }}>
            LIVE
          </span>
        </button>
        <div style={divider} />
        <CloseButton onClick={onDismiss} title="Close" />
      </div>
    );
  }

  // ─── Default: download pill ───
  return (
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
            {pct !== null ? (
              <span style={{ color: MUTED, fontSize: 11, fontWeight: 600 }}>{pct}%</span>
            ) : prog?.downloadedBytes ? (
              <span style={{ color: MUTED, fontSize: 11, fontWeight: 600 }}>{formatBytes(prog.downloadedBytes)}</span>
            ) : null}
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
      <div style={divider} />

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
};
