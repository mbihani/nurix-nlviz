import { useState, useEffect, useCallback, useRef } from 'react';
import { Trash2, Pin, X, Pencil } from 'lucide-react';
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
      <div className="text-sm text-muted-foreground text-center py-4">Loading pinned charts…</div>
    );
  }

  if (pins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-sm text-muted-foreground py-16 px-4">
        <Pin className="mb-2 opacity-30" size={32} />
        <p>No pinned charts yet.</p>
        <p className="text-xs mt-1 opacity-70">Ask Genie a question and pin a chart to see it here.</p>
      </div>
    );
  }

  const canvasMinH = Math.max(
    600,
    ...Array.from(cardLayouts.values()).map((l) => l.y + l.height + 80),
  );

  return (
    <>
      <div
        className="relative w-full"
        style={{
          minHeight: `max(80vh, ${canvasMinH}px)`,
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'%3E%3Cpath d=\'M 20 0 L 0 0 0 20\' fill=\'none\' stroke=\'%23e5e7eb\' stroke-width=\'0.5\'/%3E%3C/svg%3E")',
          backgroundSize: '20px 20px',
        }}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => { setRefiningPin(null); setRefineError(''); }}>
          <div className="bg-card rounded-xl shadow-2xl w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground">Refine chart</h3>
              <button onClick={() => { setRefiningPin(null); setRefineError(''); }}
                className="p-1 rounded hover:bg-accent text-muted-foreground"><X size={16} /></button>
            </div>
            {isRefining ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
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
                  className="flex-1 text-sm rounded-lg border border-input bg-background px-3 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  autoFocus
                />
                <button onClick={handleRefinePin} disabled={!refineInput.trim() || isRefining}
                  className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 shrink-0">
                  Apply
                </button>
              </div>
            )}
            {refineError && <p className="mt-2 text-xs text-destructive">{refineError}</p>}
          </div>
        </div>
      )}

      {/* Expand modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setExpanded(null)}
        >
          <div
            className="bg-card rounded-xl shadow-2xl w-full max-w-3xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-sm font-semibold text-foreground pr-4">{expanded.question}</h3>
              <button
                onClick={() => setExpanded(null)}
                className="p-1 rounded hover:bg-accent text-muted-foreground"
              >
                <X size={16} />
              </button>
            </div>

            {expanded.chart_config ? (
              <ChartRenderer html={expanded.chart_config as string} height={420} />
            ) : (
              <div className="h-48 flex items-center justify-center text-muted-foreground">
                No chart data
              </div>
            )}

            {expanded.sql_query && (
              <details className="mt-4">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                  SQL
                </summary>
                <pre className="mt-2 text-xs bg-muted p-3 rounded overflow-x-auto">
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

  // Allocate chart height = tile height minus header (≈36px)
  const chartHeight = Math.max(MIN_H - 36, layout.height - 48);

  return (
    <div
      className="border rounded-lg bg-card shadow-sm flex flex-col select-none animate-fade-in-up"
      style={{
        position: 'absolute',
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        minWidth: MIN_W,
        minHeight: MIN_H,
        animationDelay: `${animationDelay}ms`,
      }}
    >
      {/* Drag handle header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b bg-muted/40 rounded-t-lg cursor-grab active:cursor-grabbing shrink-0"
        onMouseDown={startDrag}
      >
        <p className="text-xs font-medium text-foreground line-clamp-1 flex-1 mr-2">
          {pin.question}
        </p>
        <div className="flex gap-1 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={onExpand}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            title="Expand"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
          <button
            onClick={() => onRefine(pin.id, pin.chart_config)}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            title="Refine chart"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Chart content — fills remaining space */}
      <div className="flex-1 overflow-hidden rounded-b-lg">
        {pin.chart_config ? (
          <ChartRenderer html={pin.chart_config as string} height={chartHeight} />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground bg-muted/30">
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
        }}
        onMouseDown={startResize}
        className="flex items-end justify-end pb-1 pr-1 text-muted-foreground/50 hover:text-muted-foreground"
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
