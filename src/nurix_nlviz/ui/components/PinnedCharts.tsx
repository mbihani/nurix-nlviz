import { useState, useEffect, useCallback, useRef } from 'react';
import { Trash2, Pin, X } from 'lucide-react';

interface PinnedChart {
  id: number;
  session_id: string;
  question: string;
  sql_query?: string;
  chart_type: string;
  chart_config: { html?: string; [key: string]: any };
  rows_json?: any[][];
  created_at?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CardState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PinnedChartsProps {
  sessionId: string;
  refreshTrigger?: number;
}

const MIN_W = 300;
const MIN_H = 200;
const GRID = 20;

function snap(v: number) {
  return Math.round(v / GRID) * GRID;
}

export function PinnedCharts({ sessionId, refreshTrigger }: PinnedChartsProps) {
  const [pins, setPins] = useState<PinnedChart[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<PinnedChart | null>(null);
  // cardLayouts is the source of truth for positions while dragging/resizing
  const [cardLayouts, setCardLayouts] = useState<Map<number, CardState>>(new Map());

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

  const persistLayout = useCallback(async (id: number, layout: CardState) => {
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
      setCardLayouts((prev) => { const next = new Map(prev); next.delete(id); return next; });
      if (expanded?.id === id) setExpanded(null);
    } catch {
      // ignore
    }
  };

  const getLayout = (pin: PinnedChart): CardState =>
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
        <p className="text-xs mt-1 opacity-70">Pin a chart from the chat to see it here.</p>
      </div>
    );
  }

  // Canvas height = max bottom edge of all cards + padding
  const canvasMinH = Math.max(
    600,
    ...Array.from(cardLayouts.values()).map((l) => l.y + l.height + 80),
  );

  return (
    <>
      <div
        className="relative w-full overflow-auto"
        style={{
          minHeight: `max(80vh, ${canvasMinH}px)`,
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'%3E%3Cpath d=\'M 20 0 L 0 0 0 20\' fill=\'none\' stroke=\'%23e5e7eb\' stroke-width=\'0.5\'/%3E%3C/svg%3E")',
          backgroundSize: '20px 20px',
        }}
      >
        {pins.map((pin) => (
          <DraggableCard
            key={pin.id}
            pin={pin}
            layout={getLayout(pin)}
            onLayoutChange={(l) => {
              setCardLayouts((prev) => new Map(prev).set(pin.id, l));
            }}
            onLayoutCommit={(l) => persistLayout(pin.id, l)}
            onDelete={() => handleDelete(pin.id)}
            onExpand={() => setExpanded(pin)}
          />
        ))}
      </div>

      {/* Expand modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setExpanded(null)}
        >
          <div
            className="bg-card rounded-xl shadow-2xl w-full max-w-2xl p-6"
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

            {expanded.chart_config?.html ? (
              <iframe
                srcDoc={expanded.chart_config.html}
                sandbox="allow-scripts"
                style={{ height: '380px', width: '100%', border: 'none', borderRadius: '8px' }}
                title={expanded.question}
              />
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
  layout: CardState;
  onLayoutChange: (l: CardState) => void;
  onLayoutCommit: (l: CardState) => void;
  onDelete: () => void;
  onExpand: () => void;
}

function DraggableCard({
  pin,
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDelete,
  onExpand,
}: DraggableCardProps) {
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

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
      onLayoutCommit(layoutRef.current);
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
      onLayoutCommit(layoutRef.current);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const html = pin.chart_config?.html ?? null;

  return (
    <div
      style={{
        position: 'absolute',
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        minWidth: MIN_W,
        minHeight: MIN_H,
      }}
      className="border rounded-lg bg-card shadow-sm flex flex-col select-none"
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
            onClick={onDelete}
            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Chart content */}
      <div className="flex-1 overflow-hidden rounded-b-lg relative">
        {html ? (
          <iframe
            srcDoc={html}
            sandbox="allow-scripts"
            style={{ width: '100%', height: '100%', border: 'none' }}
            title={pin.question}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground bg-muted/30">
            {pin.chart_type.toUpperCase()} chart
          </div>
        )}
      </div>

      {/* Resize handle (bottom-right corner) */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: 16,
          height: 16,
          cursor: 'se-resize',
        }}
        onMouseDown={startResize}
        className="flex items-end justify-end pb-0.5 pr-0.5 text-muted-foreground/50 hover:text-muted-foreground"
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
