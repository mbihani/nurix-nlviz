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

interface PinnedChartsProps {
  sessionId: string;
  refreshTrigger?: number;
  externalHtmlOverrides?: Map<number, string>;
}

const MIN_W = 320;
const MIN_H = 220;
const GRID = 20;

function snap(v: number) {
  return Math.round(v / GRID) * GRID;
}

export function PinnedCharts({ sessionId, refreshTrigger, externalHtmlOverrides }: PinnedChartsProps) {
  const [pins, setPins] = useState<PinnedChart[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<PinnedChart | null>(null);
  const [cardLayouts, setCardLayouts] = useState<Map<number, CardLayout>>(new Map());
  const [refiningPin, setRefiningPin] = useState<{ id: number; html: string } | null>(null);
  const [refineInput, setRefineInput] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [refineError, setRefineError] = useState('');
  const refineInputRef = useRef<HTMLInputElement>(null);

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
              next.set(p.id, { x: p.x ?? 0, y: p.y ?? 0, width: p.width ?? 600, height: p.height ?? 400 });
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
    cardLayouts.get(pin.id) ?? { x: pin.x ?? 0, y: pin.y ?? 0, width: pin.width ?? 600, height: pin.height ?? 400 };

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
            style={{ background: '#13131F', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '16px', boxShadow: '0 0 60px rgba(99,102,241,0.2)' }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold" style={{ color: '#F8FAFC' }}>Refine chart</h3>
              <button type="button" onClick={() => { setRefiningPin(null); setRefineError(''); }}
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: '6px', color: '#64748B', cursor: 'pointer', padding: '4px' }}><X size={16} /></button>
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
                  style={{ background: '#1A1A2A', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '8px', color: '#F8FAFC', fontSize: '13px', padding: '8px 12px', outline: 'none', flex: 1 }}
                  autoFocus
                />
                <button type="button" onClick={handleRefinePin} disabled={!refineInput.trim() || isRefining}
                  className="disabled:opacity-40 shrink-0"
                  style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', color: 'white', border: 'none', borderRadius: '8px', padding: '8px 14px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>
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
            style={{ background: '#13131F', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '16px', boxShadow: '0 0 60px rgba(99,102,241,0.2)', width: '90vw', maxWidth: '900px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-sm font-semibold pr-4" style={{ color: '#F8FAFC' }}>{expanded.question}</h3>
              <button
                type="button"
                onClick={() => setExpanded(null)}
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: '6px', color: '#64748B', cursor: 'pointer', padding: '4px' }}
              >
                <X size={16} />
              </button>
            </div>

            {expanded.chart_config ? (
              <ChartRenderer html={expanded.chart_config as string} height={420} />
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
                <pre className="mt-2 text-xs overflow-x-auto" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '6px', color: '#60A5FA', padding: '10px' }}>
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
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = layoutRef.current.x;
    const origY = layoutRef.current.y;

    const onMove = (ev: MouseEvent) => {
      const nx = snap(Math.max(0, origX + ev.clientX - startX));
      const ny = snap(Math.max(0, origY + ev.clientY - startY));
      onLayoutChange({ ...layoutRef.current, x: nx, y: ny });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      cleanupRef.current = null;
      onLayoutCommit(layoutRef.current);
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
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = layoutRef.current.width;
    const origH = layoutRef.current.height;

    const onMove = (ev: MouseEvent) => {
      const nw = snap(Math.max(MIN_W, origW + ev.clientX - startX));
      const nh = snap(Math.max(MIN_H, origH + ev.clientY - startY));
      onLayoutChange({ ...layoutRef.current, width: nw, height: nh });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      cleanupRef.current = null;
      onLayoutCommit(layoutRef.current);
    };
    cleanupRef.current = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Allocate chart height = tile height minus header (≈34px)
  const chartHeight = Math.max(MIN_H - 36, layout.height - 48);

  const actionBtnStyle: React.CSSProperties = {
    background: 'rgba(99,102,241,0.1)',
    border: '1px solid rgba(99,102,241,0.2)',
    color: '#818CF8',
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
        background: '#13131F',
        border: '1px solid rgba(99,102,241,0.18)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(99,102,241,0.08)',
        borderRadius: '12px',
        overflow: 'hidden',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        animationDelay: `${animationDelay}ms`,
      }}
    >
      {/* Drag handle header */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          background: 'linear-gradient(90deg, #0D0D1A 0%, #111128 100%)',
          borderBottom: '1px solid rgba(99,102,241,0.12)',
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

      {/* Chart content — fills remaining space */}
      <div className="flex-1 overflow-hidden">
        {pin.chart_config ? (
          <ChartRenderer html={pin.chart_config as string} height={chartHeight} />
        ) : (
          <div className="h-full flex items-center justify-center text-xs" style={{ color: '#64748B', background: 'rgba(99,102,241,0.03)' }}>
            {pin.chart_type.toUpperCase()} chart
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
          color: '#6366F1',
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
