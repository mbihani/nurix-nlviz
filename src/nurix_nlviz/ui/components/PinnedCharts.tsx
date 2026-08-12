import { useState, useEffect, useCallback, useRef } from 'react';
import { Trash2, X, Pencil } from 'lucide-react';
import { ChartRenderer } from './ChartRenderer';

interface PinnedChart {
  id: number;
  session_id: string;
  question: string;
  sql_query?: string;
  chart_type: string;
  chart_config: string;
  rows_json?: any[][];
  created_at?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CardLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PinRect {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PinnedChartsProps {
  sessionId: string;
  refreshTrigger?: number;
  externalHtmlOverrides?: Map<number, string>;
  /**
   * Reports the live rect of every pinned card (after loads, drags, resizes and
   * deletes) so the parent can place a new pin in a genuinely free slot rather
   * than against a stale snapshot.
   */
  onLayoutsChange?: (rects: PinRect[]) => void;
}

export const BENTO_GRID = { columns: 12, columnWidth: 96, rowHeight: 72, gutter: 12 } as const;
const X_STEP = BENTO_GRID.columnWidth + BENTO_GRID.gutter;
const Y_STEP = BENTO_GRID.rowHeight + BENTO_GRID.gutter;
const MIN_COLS = 3;
const MIN_ROWS = 3;
const MIN_W = MIN_COLS * BENTO_GRID.columnWidth + (MIN_COLS - 1) * BENTO_GRID.gutter;
const MIN_H = MIN_ROWS * BENTO_GRID.rowHeight + (MIN_ROWS - 1) * BENTO_GRID.gutter;

const snapPosition = (value: number, step: number) => Math.max(0, Math.round(value / step) * step);
const snapSpan = (value: number, unit: number, step: number, minimum: number) => {
  const span = Math.max(minimum, Math.round((value + BENTO_GRID.gutter) / step));
  return span * unit + (span - 1) * BENTO_GRID.gutter;
};
const snapLayout = (layout: CardLayout): CardLayout => ({
  x: snapPosition(layout.x, X_STEP),
  y: snapPosition(layout.y, Y_STEP),
  width: snapSpan(layout.width, BENTO_GRID.columnWidth, X_STEP, MIN_COLS),
  height: snapSpan(layout.height, BENTO_GRID.rowHeight, Y_STEP, MIN_ROWS),
});

// Cards stack inside a bounded band so they can never climb over the floating
// Ask button (z 40) or the chat drawer / header (z 50). Order is tracked as a
// back-to-front list and mapped onto the band, rather than by an incrementing
// counter that would grow without limit.
const BASE_Z = 10;
const MAX_Z_LEVELS = 25;
/**
 * Map a card's position in the back-to-front stack onto the z band, counting
 * DOWN from the front so the frontmost card always gets the top level. With more
 * than MAX_Z_LEVELS cards the far-back ones collapse onto BASE_Z, which is
 * harmless — they are behind everything that matters either way.
 */
const zForStackIndex = (index: number, total: number) => {
  if (index < 0) return BASE_Z;
  const fromFront = total - 1 - index;
  return BASE_Z + Math.max(0, MAX_Z_LEVELS - fromFront);
};

export function PinnedCharts({ sessionId, refreshTrigger, externalHtmlOverrides, onLayoutsChange }: PinnedChartsProps) {
  const [pins, setPins] = useState<PinnedChart[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<PinnedChart | null>(null);
  const [cardLayouts, setCardLayouts] = useState<Map<number, CardLayout>>(new Map());
  const [refiningPin, setRefiningPin] = useState<{ id: number; html: string } | null>(null);
  const [refineInput, setRefineInput] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [refineError, setRefineError] = useState('');
  const refineInputRef = useRef<HTMLInputElement>(null);

  // Client-side stacking order, back-to-front. There is no z/order column on
  // pinned_charts, so this is session-only by design — nothing is persisted.
  const [stack, setStack] = useState<number[]>([]);

  const bringToFront = useCallback((id: number) => {
    setStack((prev) => {
      // Already frontmost — don't churn state on every mousedown.
      if (prev[prev.length - 1] === id) return prev;
      return [...prev.filter((pid) => pid !== id), id];
    });
  }, []);

  const loadPins = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/pins?session_id=${encodeURIComponent(sessionId)}`);
      if (res.ok) {
        const data: PinnedChart[] = await res.json();
        setPins(data);
        setCardLayouts((prev) => {
          const next = new Map(prev);
          data.forEach((p) => {
            if (!next.has(p.id)) {
              next.set(p.id, snapLayout({ x: p.x ?? 0, y: p.y ?? 0, width: p.width ?? 528, height: p.height ?? 408 }));
            }
          });
          return next;
        });
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadPins();
  }, [loadPins, refreshTrigger]);

  // Sync the stack with the loaded pins: drop deleted ids, and append ids we
  // have not seen yet oldest-first so the newest pin lands frontmost.
  // list_pins returns created_at DESC, hence the reverse.
  useEffect(() => {
    setStack((prev) => {
      const live = new Set(pins.map((p) => p.id));
      const kept = prev.filter((id) => live.has(id));
      const known = new Set(kept);
      const added = pins.map((p) => p.id).reverse().filter((id) => !known.has(id));
      if (added.length === 0 && kept.length === prev.length) return prev;
      return [...kept, ...added];
    });
  }, [pins]);

  // Publish live rects so the parent places new pins against real positions.
  useEffect(() => {
    if (!onLayoutsChange) return;
    onLayoutsChange(pins.map((p) => ({ id: p.id, ...getLayout(p) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, cardLayouts, onLayoutsChange]);

  const persistLayout = useCallback(async (id: number, layout: CardLayout) => {
    try {
      await fetch(`/api/pins/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: layout.x, y: layout.y, width: layout.width, height: layout.height }),
      });
    } catch {
      // non-critical
    }
  }, []);

  const handleDelete = async (id: number) => {
    try {
      await fetch(`/api/pins/${id}`, { method: 'DELETE' });
      setPins((prev) => prev.filter((p) => p.id !== id));
      setCardLayouts((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      if (expanded?.id === id) setExpanded(null);
    } catch {
      // ignore
    }
  };

  const handleRefinePin = useCallback(async () => {
    if (!refiningPin || !refineInput.trim() || isRefining) return;
    setIsRefining(true);
    setRefineError('');
    try {
      const res = await fetch('/api/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          chart_html: refiningPin.html,
          refine_instruction: refineInput.trim(),
          columns: [],
        }),
      });
      const data = await res.json();
      if (data.chart_html && typeof data.chart_html === 'string') {
        // Update pin in state
        setPins((prev) => prev.map((p) => p.id === refiningPin.id ? { ...p, chart_config: data.chart_html } : p));
        // Persist via PATCH
        await fetch(`/api/pins/${refiningPin.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chart_config: data.chart_html }),
        });
        setRefiningPin(null);
        setRefineInput('');
      } else {
        setRefineError('Refinement returned an invalid chart. Original kept.');
      }
    } catch {
      setRefineError('Refinement failed. Please try again.');
    } finally {
      setIsRefining(false);
    }
  }, [refiningPin, refineInput, isRefining, sessionId]);

  const getLayout = (pin: PinnedChart): CardLayout =>
    cardLayouts.get(pin.id) ?? snapLayout({ x: pin.x ?? 0, y: pin.y ?? 0, width: pin.width ?? 528, height: pin.height ?? 408 });

  if (loading && pins.length === 0) {
    return (
      <div className="text-sm text-center py-4" style={{ color: '#64748B' }}>Loading pinned charts…</div>
    );
  }

  // Empty state is owned by the parent canvas (index.tsx) — render nothing here.
  if (pins.length === 0) {
    return null;
  }

  const canvasMinH = Math.max(
    600,
    ...Array.from(cardLayouts.values()).map((l) => l.y + l.height + 80),
  );

  return (
    <>
      <div
        className="relative w-full"
        style={{ minHeight: `max(80vh, ${canvasMinH}px)` }}
      >
        {pins.map((pin, idx) => {
          const overrideHtml = externalHtmlOverrides?.get(pin.id);
          return (
            <DraggableCard
              key={pin.id}
              pin={overrideHtml ? { ...pin, chart_config: overrideHtml } : pin}
              layout={getLayout(pin)}
              animationDelay={idx * 60}
              zIndex={zForStackIndex(stack.indexOf(pin.id), stack.length)}
              onActivate={() => bringToFront(pin.id)}
              onLayoutChange={(l) => setCardLayouts((prev) => new Map(prev).set(pin.id, l))}
              onLayoutCommit={(l) => persistLayout(pin.id, l)}
              onDelete={() => handleDelete(pin.id)}
              onExpand={() => setExpanded(pin)}
              onRefine={(id, html) => { setRefiningPin({ id, html }); setRefineInput(''); setRefineError(''); }}
            />
          );
        })}
      </div>

      {/* Refine modal */}
      {refiningPin && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)' }}
          onClick={() => { setRefiningPin(null); setRefineError(''); }}>
          <div className="w-full max-w-md p-5"
            style={{ background: '#0F172A', border: '1px solid #1E293B', borderRadius: '8px' }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold" style={{ color: '#FFFFFF' }}>Refine chart</h3>
              <button type="button" onClick={() => { setRefiningPin(null); setRefineError(''); }}
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(8,145,178,0.15)', borderRadius: '6px', color: '#64748B', cursor: 'pointer', padding: '4px' }}><X size={16} /></button>
            </div>
            {isRefining ? (
              <div className="flex items-center gap-2 py-4 text-sm" style={{ color: '#94A3B8' }}>
                <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
                <span className="ml-1">Refining chart…</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  ref={refineInputRef}
                  type="text"
                  value={refineInput}
                  onChange={(e) => setRefineInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRefinePin(); if (e.key === 'Escape') { setRefiningPin(null); setRefineError(''); } }}
                  placeholder="e.g. make it a line chart, sort descending…"
                  style={{ background: '#1E293B', border: '1px solid rgba(8,145,178,0.25)', borderRadius: '8px', color: '#FFFFFF', fontSize: '13px', padding: '8px 12px', outline: 'none', flex: 1 }}
                  autoFocus
                />
                <button type="button" onClick={handleRefinePin} disabled={!refineInput.trim() || isRefining}
                  className="disabled:opacity-40 shrink-0"
                  style={{ background: '#0891B2', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 14px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>
                  Apply
                </button>
              </div>
            )}
            {refineError && <p className="mt-2 text-xs" style={{ color: '#EF4444' }}>{refineError}</p>}
          </div>
        </div>
      )}

      {/* Expand modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)' }}
          onClick={() => setExpanded(null)}
        >
          <div
            className="p-6"
            style={{ background: '#0F172A', border: '1px solid rgba(8,145,178,0.25)', borderRadius: '8px', width: '90vw', maxWidth: '900px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-sm font-semibold pr-4" style={{ color: '#FFFFFF' }}>{expanded.question}</h3>
              <button
                type="button"
                onClick={() => setExpanded(null)}
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(8,145,178,0.15)', borderRadius: '6px', color: '#64748B', cursor: 'pointer', padding: '4px' }}
              >
                <X size={16} />
              </button>
            </div>

            {expanded.chart_config ? (
              <div style={{ flex: 1, minHeight: 420, overflow: 'hidden' }}>
                <ChartRenderer html={expanded.chart_config as string} title={expanded.question} hideTitle />
              </div>
            ) : (
              <div className="h-48 flex items-center justify-center" style={{ color: '#64748B' }}>
                No chart data
              </div>
            )}

            {expanded.sql_query && (
              <details className="mt-4">
                <summary className="text-xs cursor-pointer" style={{ color: '#64748B' }}>
                  SQL
                </summary>
                <pre className="mt-2 text-xs overflow-x-auto" style={{ background: 'rgba(8,145,178,0.08)', border: '1px solid rgba(8,145,178,0.2)', borderRadius: '6px', color: '#22D3EE', padding: '10px' }}>
                  {expanded.sql_query}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface DraggableCardProps {
  pin: PinnedChart;
  layout: CardLayout;
  animationDelay?: number;
  zIndex: number;
  /** Raise this card above its neighbours (drag start, resize start, any click). */
  onActivate: () => void;
  onLayoutChange: (l: CardLayout) => void;
  onLayoutCommit: (l: CardLayout) => void;
  onDelete: () => void;
  onExpand: () => void;
  onRefine: (pinId: number, currentHtml: string) => void;
}

function DraggableCard({
  pin,
  layout,
  animationDelay = 0,
  zIndex,
  onActivate,
  onLayoutChange,
  onLayoutCommit,
  onDelete,
  onExpand,
  onRefine,
}: DraggableCardProps) {
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    onActivate();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = layoutRef.current.x;
    const origY = layoutRef.current.y;

    const onMove = (ev: MouseEvent) => {
      const nx = Math.max(0, origX + ev.clientX - startX);
      const ny = Math.max(0, origY + ev.clientY - startY);
      onLayoutChange({ ...layoutRef.current, x: nx, y: ny });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      cleanupRef.current = null;
      const snapped = snapLayout(layoutRef.current);
      onLayoutChange(snapped);
      onLayoutCommit(snapped);
    };
    cleanupRef.current = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onActivate();
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = layoutRef.current.width;
    const origH = layoutRef.current.height;

    const onMove = (ev: MouseEvent) => {
      const nw = Math.max(MIN_W, origW + ev.clientX - startX);
      const nh = Math.max(MIN_H, origH + ev.clientY - startY);
      onLayoutChange({ ...layoutRef.current, width: nw, height: nh });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      cleanupRef.current = null;
      const snapped = snapLayout(layoutRef.current);
      onLayoutChange(snapped);
      onLayoutCommit(snapped);
    };
    cleanupRef.current = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const actionBtnStyle: React.CSSProperties = {
    background: '#0F172A',
    border: '1px solid #1E293B',
    color: '#22D3EE',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '10px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
  };

  return (
    <div
      className="flex flex-col select-none animate-fade-in-up"
      style={{
        position: 'absolute',
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        minWidth: MIN_W,
        minHeight: MIN_H,
        background: '#0F172A',
        border: '1px solid #1E293B',
        boxShadow: 'none',
        borderRadius: '8px',
        overflow: 'hidden',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        animationDelay: `${animationDelay}ms`,
        zIndex,
      }}
      onMouseDownCapture={onActivate}
    >
      {/* Drag handle header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          background: '#0F172A',
          borderBottom: '1px solid #1E293B',
          padding: '7px 10px',
          cursor: 'grab',
          height: '34px',
        }}
        onMouseDown={startDrag}
      >
        <p style={{ color: '#94A3B8', fontSize: '11px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: '8px' }}>
          {pin.question}
        </p>
        <div className="flex gap-1 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" onClick={onExpand} style={actionBtnStyle} title="Expand">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
          <button type="button" onClick={() => onRefine(pin.id, pin.chart_config)} style={actionBtnStyle} title="Refine chart">
            <Pencil size={11} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            style={{ ...actionBtnStyle, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#EF4444' }}
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {/* Chart content — borderless, flush to the card, fills remaining space.
          No padding/border/background here: the chart auto-fits this box and the
          card's own drag header above is the only chrome. */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {pin.chart_config ? (
          <ChartRenderer html={pin.chart_config as string} title={pin.question} hideTitle />
        ) : (
          <div className="h-full flex items-center justify-center text-xs" style={{ color: '#64748B' }}>
            No chart data
          </div>
        )}
      </div>

      {/* Resize handle — bottom-right corner */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: 18,
          height: 18,
          cursor: 'se-resize',
          zIndex: 10,
          color: '#22D3EE',
          opacity: 0.5,
        }}
        onMouseDown={startResize}
        className="flex items-end justify-end pb-1 pr-1"
        title="Resize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <rect x="6" y="6" width="2" height="2" />
          <rect x="3" y="6" width="2" height="2" />
          <rect x="6" y="3" width="2" height="2" />
        </svg>
      </div>
    </div>
  );
}
