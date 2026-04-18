import type { MediaItem } from '@extension/shared';
import { GLASS_PANEL, GLASS_BORDER, BLUR, TEXT, MUTED, HOVER } from './tokens';
import { IcoDown } from './icons';
import { kindStr } from '../lib/media-helpers';

type Row = { label: string; sub: string; item: MediaItem; variantUrl?: string };

export const DropdownPanel = ({
  rows,
  primary,
  bestUrl,
  bestQLabel,
  onDownload,
}: {
  rows: Row[];
  primary: MediaItem;
  bestUrl: string;
  bestQLabel: string;
  onDownload: (item: MediaItem, variantUrl?: string) => void;
}) => (
  <div
    style={{
      background: GLASS_PANEL,
      backdropFilter: BLUR,
      WebkitBackdropFilter: BLUR,
      border: `1px solid ${GLASS_BORDER}`,
      borderTop: 'none',
      borderRadius: '0 0 10px 10px',
      overflow: 'hidden',
      minWidth: 220,
      maxWidth: 300,
      boxShadow: '0 10px 28px rgba(0,0,0,0.6)',
    }}>
    {/* Best quality shortcut */}
    <button
      onClick={() => onDownload(primary, bestUrl)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        background: 'rgba(255,255,255,0.05)',
        border: 'none',
        borderBottom: `1px solid ${GLASS_BORDER}`,
        padding: '7px 12px',
        cursor: 'pointer',
        textAlign: 'left',
        color: TEXT,
        fontSize: 11,
        fontWeight: 700,
      }}
      onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = HOVER)}
      onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)')}>
      <IcoDown />
      <span>Download best quality</span>
      {bestQLabel && <span style={{ marginLeft: 'auto', color: MUTED, fontSize: 10 }}>{bestQLabel}</span>}
    </button>

    {/* Quality rows */}
    {rows.map((row, idx) => (
      <button
        key={`${row.item.url}-${idx}`}
        onClick={() => onDownload(row.item, row.variantUrl)}
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 1,
          background: 'none',
          border: 'none',
          borderBottom: idx < rows.length - 1 ? `1px solid rgba(255,255,255,0.06)` : 'none',
          padding: '6px 12px 6px 24px',
          cursor: 'pointer',
          textAlign: 'left',
          position: 'relative',
        }}
        onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = HOVER)}
        onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'none')}>
        {idx === 0 && (
          <span
            style={{
              position: 'absolute',
              left: 9,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'rgba(255,255,255,0.35)',
              fontSize: 8,
            }}>
            ▶
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            color: TEXT,
            fontWeight: idx === 0 ? 600 : 400,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 270,
          }}>
          {row.label}
        </span>
        <span style={{ fontSize: 9.5, color: MUTED }}>{row.sub}</span>
      </button>
    ))}

    {/* Footer */}
    <div
      style={{
        padding: '4px 12px',
        borderTop: `1px solid ${GLASS_BORDER}`,
        display: 'flex',
        justifyContent: 'space-between',
      }}>
      <span style={{ color: MUTED, fontSize: 9 }}>
        {rows.length} option{rows.length !== 1 ? 's' : ''}
      </span>
      <span style={{ color: MUTED, fontSize: 9 }}>{kindStr(primary.kind)}</span>
    </div>
  </div>
);
