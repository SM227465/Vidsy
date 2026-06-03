import { GLASS_PANEL, GLASS_BORDER, BLUR, TEXT, MUTED, HOVER, FONT } from './tokens';
import { MEDIA_MESSAGE } from '@extension/shared';
import { useState } from 'react';

type Intercept = {
  url: string;
  fileName?: string;
  mime?: string;
  fileSize?: number;
  referrer?: string;
};

const formatBytes = (bytes: number | undefined): string => {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso']);
const DOC_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt']);

type FileKind = 'video' | 'audio' | 'image' | 'archive' | 'apk' | 'document' | 'other';

const extensionOf = (filename: string | undefined): string => {
  if (!filename) return '';
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
};

const detectFileKind = (mime: string | undefined, filename: string | undefined): FileKind => {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/vnd.android.package-archive') return 'apk';
  if (m === 'application/pdf') return 'document';
  if (m.startsWith('application/zip') || m.includes('compressed')) return 'archive';
  const ext = extensionOf(filename);
  if (ext === 'apk') return 'apk';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (DOC_EXTS.has(ext)) return 'document';
  if (['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'ts'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'aac', 'flac', 'wav', 'opus', 'ogg'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  return 'other';
};

const categoryFromKind = (kind: FileKind): string => {
  switch (kind) {
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'image':
      return 'Image';
    case 'archive':
      return 'Compressed';
    case 'apk':
      return 'Android Package';
    case 'document':
      return 'Document';
    default:
      return 'Other';
  }
};

const KIND_STYLE: Record<FileKind, { bg: string; border: string; color: string }> = {
  video: { bg: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.35)', color: '#60a5fa' },
  audio: { bg: 'rgba(168,85,247,0.15)', border: 'rgba(168,85,247,0.35)', color: '#c084fc' },
  image: { bg: 'rgba(236,72,153,0.15)', border: 'rgba(236,72,153,0.35)', color: '#f472b6' },
  archive: { bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.35)', color: '#fbbf24' },
  apk: { bg: 'rgba(34,197,94,0.15)', border: 'rgba(34,197,94,0.35)', color: '#4ade80' },
  document: { bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.35)', color: '#f87171' },
  other: { bg: 'rgba(148,163,184,0.15)', border: 'rgba(148,163,184,0.35)', color: '#cbd5e1' },
};

const FileKindIcon = ({ kind }: { kind: FileKind }) => {
  const stroke = KIND_STYLE[kind].color;
  const common = { width: 30, height: 30, viewBox: '0 0 24 24', fill: 'none', stroke, strokeWidth: 1.6 };
  switch (kind) {
    case 'video':
      return (
        <svg {...common}>
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      );
    case 'audio':
      return (
        <svg {...common}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      );
    case 'image':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case 'archive':
      return (
        <svg {...common}>
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1z" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      );
    case 'apk':
      return (
        <svg {...common}>
          <line x1="6" y1="20" x2="6" y2="14" />
          <line x1="18" y1="20" x2="18" y2="14" />
          <path d="M4 14a8 8 0 0 1 16 0v6H4z" />
          <line x1="9" y1="9" x2="8" y2="6" />
          <line x1="15" y1="9" x2="16" y2="6" />
        </svg>
      );
    case 'document':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="13 2 13 9 20 9" />
        </svg>
      );
  }
};

const fieldLabelStyle: React.CSSProperties = {
  width: 70,
  flexShrink: 0,
  fontSize: 11,
  color: MUTED,
  paddingTop: 6,
  fontFamily: FONT,
};

const fieldValueStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 11,
  color: TEXT,
  background: 'rgba(255,255,255,0.04)',
  border: `1px solid ${GLASS_BORDER}`,
  borderRadius: 4,
  padding: '5px 8px',
  fontFamily: FONT,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
};

const buttonBase: React.CSSProperties = {
  minWidth: 120,
  padding: '8px 14px',
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 6,
  cursor: 'pointer',
  fontFamily: FONT,
  border: 'none',
};

export const InterceptModal = ({ intercept, onClose }: { intercept: Intercept; onClose: () => void }) => {
  const initialFilename = intercept.fileName ?? 'Download';
  const [editedFilename, setEditedFilename] = useState(initialFilename);
  const size = formatBytes(intercept.fileSize);
  const kind = detectFileKind(intercept.mime, intercept.fileName);
  const category = categoryFromKind(kind);
  const kindStyle = KIND_STYLE[kind];

  // Trim whitespace, fall back to the original if the user emptied the field.
  const finalFilename = (() => {
    const trimmed = editedFilename.trim();
    return trimmed.length > 0 ? trimmed : initialFilename;
  })();

  const startDownload = () => {
    void chrome.runtime.sendMessage({
      type: MEDIA_MESSAGE.INTERCEPT_DOWNLOAD_VIDSY,
      payload: { url: intercept.url, fileName: finalFilename },
    });
    onClose();
  };

  const openInBrowser = () => {
    void chrome.runtime.sendMessage({
      type: MEDIA_MESSAGE.INTERCEPT_RESUME_BROWSER,
      payload: { url: intercept.url, fileName: finalFilename },
    });
    onClose();
  };

  const cancel = () => {
    void chrome.runtime.sendMessage({
      type: MEDIA_MESSAGE.INTERCEPT_DISMISS,
      payload: { url: intercept.url },
    });
    onClose();
  };

  return (
    <div
      role="presentation"
      onClick={e => {
        // Only dismiss on backdrop click, not on clicks inside the modal —
        // avoids needing stopPropagation on the inner content.
        if (e.target === e.currentTarget) cancel();
      }}
      onKeyDown={e => {
        if (e.key === 'Escape') cancel();
      }}
      tabIndex={-1}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
        fontFamily: FONT,
        zIndex: 2147483646,
      }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Download File Info"
        style={{
          background: GLASS_PANEL,
          backdropFilter: BLUR,
          WebkitBackdropFilter: BLUR,
          border: `1px solid ${GLASS_BORDER}`,
          borderRadius: 10,
          width: 520,
          maxWidth: '92vw',
          color: TEXT,
          boxShadow: '0 24px 60px rgba(0,0,0,0.7)',
          overflow: 'hidden',
        }}>
        {/* Title bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            background: 'rgba(255,255,255,0.04)',
            borderBottom: `1px solid ${GLASS_BORDER}`,
          }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>Download File Info</span>
          <button
            onClick={cancel}
            style={{
              background: 'transparent',
              border: 'none',
              color: MUTED,
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 2,
            }}
            title="Dismiss">
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ display: 'flex', gap: 14, padding: 16 }}>
          {/* Left: fields */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 8 }}>
              <span style={fieldLabelStyle}>URL</span>
              <div style={fieldValueStyle} title={intercept.url}>
                {intercept.url}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 8 }}>
              <span style={fieldLabelStyle}>Save As</span>
              <input
                type="text"
                value={editedFilename}
                onChange={e => setEditedFilename(e.target.value)}
                onKeyDown={e => {
                  // Don't let the page (or our modal's escape handler) intercept
                  // key presses while the field has focus.
                  e.stopPropagation();
                  if (e.key === 'Enter') startDownload();
                }}
                style={{
                  ...fieldValueStyle,
                  outline: 'none',
                }}
                onFocus={e => {
                  (e.currentTarget as HTMLInputElement).style.borderColor = 'rgba(59,130,246,0.55)';
                  // Select the basename so the user can immediately overwrite
                  // it without losing the extension.
                  const val = (e.currentTarget as HTMLInputElement).value;
                  const dot = val.lastIndexOf('.');
                  if (dot > 0) (e.currentTarget as HTMLInputElement).setSelectionRange(0, dot);
                }}
                onBlur={e => ((e.currentTarget as HTMLInputElement).style.borderColor = GLASS_BORDER)}
                title={finalFilename}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 8 }}>
              <span style={fieldLabelStyle}>Category</span>
              <div style={fieldValueStyle}>{category}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start' }}>
              <span style={fieldLabelStyle}>Type</span>
              <div style={fieldValueStyle}>{intercept.mime || '—'}</div>
            </div>
          </div>

          {/* Right: file icon + size */}
          <div
            style={{
              width: 100,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 10,
                background: kindStyle.bg,
                border: `1px solid ${kindStyle.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <FileKindIcon kind={kind} />
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: TEXT, textAlign: 'center' }}>{size}</div>
          </div>
        </div>

        {/* Footnote about disabling */}
        <div
          style={{
            padding: '0 16px 10px',
            fontSize: 10,
            color: MUTED,
            fontStyle: 'italic',
            textAlign: 'center',
          }}>
          To turn this off, go to Vidsy Options → Catch browser downloads
        </div>

        {/* Button row */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
            padding: '12px 16px',
            background: 'rgba(0,0,0,0.2)',
            borderTop: `1px solid ${GLASS_BORDER}`,
          }}>
          <button
            onClick={startDownload}
            style={{ ...buttonBase, background: '#3b82f6', color: '#fff' }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = '#2563eb')}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = '#3b82f6')}>
            Start Download
          </button>
          <button
            onClick={openInBrowser}
            style={{
              ...buttonBase,
              background: 'rgba(255,255,255,0.06)',
              color: TEXT,
              border: `1px solid ${GLASS_BORDER}`,
            }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = HOVER)}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)')}>
            Open in Browser
          </button>
          <button
            onClick={cancel}
            style={{
              ...buttonBase,
              background: 'rgba(255,255,255,0.04)',
              color: MUTED,
              border: `1px solid ${GLASS_BORDER}`,
            }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = HOVER)}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)')}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
