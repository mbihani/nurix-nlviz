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
  canvasWidth: number;
  refreshTrigger?: number;
  externalHtmlOverrides?: Map<number, string>;
  /**
   * Reports the live rect of every pinned card (after loads, drags, resizes and
   * deletes) so the parent can place a new pin in a genuinely free slot rather
   * than against a stale snapshot.
   */
  onLayoutsChange?: (rects: PinRect[]) => void;
}

export const BENTO_GRID = { columns: 12, rowHeight: 72, gutter: 12 } as const;
export const Y_STEP = BENTO_GRID.rowHeight + BENTO_GRID.gutter;
export const MIN_COLS = 3;
const MIN_ROWS = 3;
const MIN_H = MIN_ROWS * BENTO_GRID.rowHeight + (MIN_ROWS - 1) * BENTO_GRID.gutter;

export const getGridMetrics = (width: number) => {
  const gridWidth = Math.max(1, width);
  const columnWidth = Math.max(1, (gridWidth - (BENTO_GRID.columns - 1) * BENTO_GRID.gutter) / BENTO_GRID.columns);
  return { gridWidth, columnWidth, xStep: columnWidth + BENTO_GRID.gutter };
};

const snapPosition = (value: number, step: number) => Math.max(0, Math.round(value / step) * step);
const snapSpan = (value: number, unit: number, step: number, minimum: number) => {
  const span = Math.max(minimum, Math.round((value + BENTO_GRID.gutter) / step));
  return span * unit + (span - 1) * BENTO_GRID.gutter;
};
const snapLayout = (layout: CardLayout, gridWidth: number): CardLayout => {
  const { columnWidth, xStep } = getGridMetrics(gridWidth);
  const colSpan = Math.min(BENTO_GRID.columns, Math.max(MIN_COLS, Math.round((layout.width + BENTO_GRID.gutter) / xStep)));
  const col = Math.min(BENTO_GRID.columns - colSpan, Math.max(0, Math.round(layout.x / xStep)));
  return {
  x: col * xStep,
  y: snapPosition(layout.y, Y_STEP),
  width: colSpan * columnWidth + (colSpan - 1) * BENTO_GRID.gutter,
  height: snapSpan(layout.height, BENTO_GRID.rowHeight, Y_STEP, MIN_ROWS),
  };
};

const reflowLayout = (layout: CardLayout, oldWidth: number, newWidth: number) => {
  const oldGrid = getGridMetrics(oldWidth);
  const col = Math.round(layout.x / oldGrid.xStep);
  const colSpan = Math.min(BENTO_GRID.columns, Math.max(MIN_COLS, Math.round((layout.width + BENTO_GRID.gutter) / oldGrid.xStep)));
  return snapLayout({ ...layout, x: col * getGridMetrics(newWidth).xStep, width: colSpan * getGridMetrics(newWidth).columnWidth + (colSpan - 1) * BENTO_GRID.gutter }, newWidth);
};

export const rectsOverlap = (a: Omit<PinRect, 'id'> | PinRect, b: PinRect) => !(
  a.x + a.width + BENTO_GRID.gutter <= b.x ||
  b.x + b.width + BENTO_GRID.gutter <= a.x ||
  a.y + a.height + BENTO_GRID.gutter <= b.y ||
  b.y + b.height + BENTO_GRID.gutter <= a.y
);

/** Find the closest collision-free grid point, expanding in Manhattan rings. */
const nearestFreeLayout = (layout: CardLayout, occupied: PinRect[], gridWidth: number): CardLayout => {
  const { xStep } = getGridMetrics(gridWidth);
  if (!occupied.some((rect) => rectsOverlap(layout, rect))) return layout;
  const startCol = Math.round(layout.x / xStep);
  const startRow = Math.round(layout.y / Y_STEP);
  for (let radius = 1; radius < 200; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      const dx = radius - Math.abs(dy);
      const candidates = dx === 0 ? [[startCol, startRow + dy]] : [
        [startCol - dx, startRow + dy],
        [startCol + dx, startRow + dy],
      ];
      for (const [col, row] of candidates) {
        if (col < 0 || row < 0 || col * xStep + layout.width > gridWidth + 0.5) continue;
        const candidate = { ...layout, x: col * xStep, y: row * Y_STEP };
        if (!occupied.some((rect) => rectsOverlap(candidate, rect))) return candidate;
      }
    }
  }
  return layout;
};

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

export function PinnedCharts({ sessionId, canvasWidth, refreshTrigger, externalHtmlOverrides, onLayoutsChange }: PinnedChartsProps) {
  const [pins, setPins] = useState<PinnedChart[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<PinnedChart | null>(null);
  const [cardLayouts, setCardLayouts] = useState<Map<number, CardLayout>>(new Map());
  const [refiningPin, setRefiningPin] = useState<{ id: number; html: string } | null>(null);
  const [refineInput, setRefineInput] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [refineError, setRefineError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const previousCanvasWidth = useRef(canvasWidth);
  const canvasWidthRef = useRef(canvasWidth);
  canvasWidthRef.current = canvasWidth;
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
          const occupied: PinRect[] = [];
          data.forEach((p) => {
            if (!next.has(p.id)) {
              const snapped = snapLayout({ x: p.x ?? 0, y: p.y ?? 0, width: p.width ?? 528, height: p.height ?? 408 }, canvasWidthRef.current);
              next.set(p.id, nearestFreeLayout(snapped, occupied, canvasWidthRef.current));
            }
            occupied.push({ id: p.id, ...(next.get(p.id) as CardLayout) });
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
    const oldWidth = previousCanvasWidth.current;
    if (canvasWidth <= 0 || oldWidth <= 0 || Math.abs(canvasWidth - oldWidth) < 1) return;
    setCardLayouts((prev) => {
      const next = new Map<number, CardLayout>();
      const occupied: PinRect[] = [];
      pins.forEach((pin) => {
        const current = prev.get(pin.id) ?? snapLayout(pin, oldWidth);
        const flowed = reflowLayout(current, oldWidth, canvasWidth);
        const resolved = nearestFreeLayout(flowed, occupied, canvasWidth);
        next.set(pin.id, resolved);
        occupied.push({ id: pin.id, ...resolved });
      });
      return next;
    });
    previousCanvasWidth.current = canvasWidth;
  }, [canvasWidth, pins]);

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
        body: JSON.stringify({
          x: Math.round(layout.x),
          y: Math.round(layout.y),
          width: Math.round(layout.width),
          height: Math.round(layout.height),
        }),
      });
    } catch {
      // non-critical
    }
  }, []);

  const handleDelete = async (id: number) => {
    setDeleteError('');
    try {
      const res = await fetch(`/api/pins/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setPins((prev) => prev.filter((p) => p.id !== id));
      setCardLayouts((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      if (expanded?.id === id) setExpanded(null);
    } catch {
      setDeleteError('Could not delete this visualization. Please try again.');
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
    cardLayouts.get(pin.id) ?? snapLayout({ x: pin.x ?? 0, y: pin.y ?? 0, width: pin.width ?? 528, height: pin.height ?? 408 }, canvasWidth);

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
        style={{ width: '100%', minHeight: `max(80vh, ${canvasMinH}px)` }}
      >
        {pins.map((pin, idx) => {
          const overrideHtml = externalHtmlOverrides?.get(pin.id);
          return (
            <DraggableCard
              key={pin.id}
              pin={overrideHtml ? { ...pin, chart_config: overrideHtml } : pin}
              layout={getLayout(pin)}
              canvasWidth={canvasWidth}
              animationDelay={idx * 60}
              zIndex={zForStackIndex(stack.indexOf(pin.id), stack.length)}
              onActivate={() => bringToFront(pin.id)}
              onLayoutChange={(l) => setCardLayouts((prev) => new Map(prev).set(pin.id, l))}
              onLayoutCommit={(l, avoidCollisions) => {
                const occupied = pins.filter((other) => other.id !== pin.id).map((other) => ({ id: other.id, ...getLayout(other) }));
                const resolved = avoidCollisions ? nearestFreeLayout(l, occupied, canvasWidth) : l;
                setCardLayouts((prev) => new Map(prev).set(pin.id, resolved));
                persistLayout(pin.id, resolved);
              }}
              onDelete={() => handleDelete(pin.id)}
              onExpand={() => setExpanded(pin)}
              onRefine={(id, html) => { setRefiningPin({ id, html }); setRefineInput(''); setRefineError(''); }}
            />
          );
        })}
      </div>

      {deleteError && <div role="alert" style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 39, background: '#0F172A', border: '1px solid #1E293B', color: '#FFFFFF', padding: '8px 12px', borderRadius: 6 }}>{deleteError}</div>}

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
            style={{ background: '#020617', border: '1px solid #131C2E', borderRadius: '8px', width: '90vw', maxWidth: '900px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
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
  canvasWidth: number;
  animationDelay?: number;
  zIndex: number;
  /** Raise this card above its neighbours (drag start, resize start, any click). */
  onActivate: () => void;
  onLayoutChange: (l: CardLayout) => void;
  onLayoutCommit: (l: CardLayout, avoidCollisions: boolean) => void;
  onDelete: () => void;
  onExpand: () => void;
  onRefine: (pinId: number, currentHtml: string) => void;
}

function DraggableCard({
  pin,
  layout,
  canvasWidth,
  animationDelay = 0,
  zIndex,
  onActivate,
  onLayoutChange,
  onLayoutCommit,
  onDelete,
  onExpand,
  onRefine,
}: DraggableCardProps) {
  const { columnWidth } = getGridMetrics(canvasWidth);
  const minWidth = MIN_COLS * columnWidth + (MIN_COLS - 1) * BENTO_GRID.gutter;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const cleanupRef = useRef<(() => void) | null>(null);
  const [isInteracting, setIsInteracting] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    onActivate();
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    handle.setPointerCapture(pointerId);
    setIsInteracting(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = layoutRef.current.x;
    const origY = layoutRef.current.y;

    let liveLayout = layoutRef.current;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const nx = Math.max(0, origX + ev.clientX - startX);
      const ny = Math.max(0, origY + ev.clientY - startY);
      liveLayout = { ...liveLayout, x: nx, y: ny };
      layoutRef.current = liveLayout;
      onLayoutChange(liveLayout);
    };
    const removeListeners = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* handle may have unmounted */ }
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      removeListeners();
      cleanupRef.current = null;
      setIsInteracting(false);
      const snapped = snapLayout(liveLayout, canvasWidth);
      onLayoutChange(snapped);
      onLayoutCommit(snapped, true);
    };
    cleanupRef.current = () => {
      removeListeners();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onActivate();
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    handle.setPointerCapture(pointerId);
    setIsInteracting(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = layoutRef.current.width;
    const origH = layoutRef.current.height;

    let liveLayout = layoutRef.current;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const nw = Math.max(minWidth, origW + ev.clientX - startX);
      const nh = Math.max(MIN_H, origH + ev.clientY - startY);
      liveLayout = { ...liveLayout, width: nw, height: nh };
      layoutRef.current = liveLayout;
      onLayoutChange(liveLayout);
    };
    const removeListeners = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* handle may have unmounted */ }
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      removeListeners();
      cleanupRef.current = null;
      setIsInteracting(false);
      const snapped = snapLayout(liveLayout, canvasWidth);
      onLayoutChange(snapped);
      onLayoutCommit(snapped, false);
    };
    cleanupRef.current = () => {
      removeListeners();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
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
      data-nlviz-pinned-card
      title={pin.question}
      style={{
        position: 'absolute',
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        minWidth,
        minHeight: MIN_H,
        background: '#020617',
        border: '1px solid #131C2E',
        boxShadow: 'none',
        borderRadius: '8px',
        overflow: 'hidden',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        animationDelay: `${animationDelay}ms`,
        zIndex,
      }}
      onMouseDownCapture={onActivate}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Transparent top drag zone: above the iframe, below card controls. */}
      <div
        data-nlviz-drag-zone
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 28,
          cursor: 'grab',
          zIndex: 8,
          borderTop: isHovered ? '1px solid #334155' : '1px solid transparent',
          transition: 'border-color 0.15s',
        }}
        onPointerDown={startDrag}
      />

      {/* Actions float over the visualization and never intercept input at rest. */}
      <div
        data-nlviz-hover-actions
        className="flex gap-1 shrink-0"
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          zIndex: 9,
          opacity: isHovered ? 1 : 0,
          pointerEvents: isHovered ? 'auto' : 'none',
          transition: 'opacity 0.15s',
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
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

      {/* Chart content — borderless and flush to every edge of the card. */}
      <div data-nlviz-chart-content className="flex-1 min-h-0 overflow-hidden">
        {pin.chart_config ? (
          <ChartRenderer html={pin.chart_config as string} title={pin.question} hideTitle isInteracting={isInteracting} />
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
        onPointerDown={startResize}
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
