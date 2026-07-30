import { useState, useEffect, useCallback } from 'react';
import { Trash2, Pin, Expand, X } from 'lucide-react';
import { ChartRenderer } from './ChartRenderer';

interface PlotlyFigure {
  data: any[];
  layout: any;
}

interface PinnedChart {
  id: number;
  session_id: string;
  question: string;
  sql_query?: string;
  chart_type: string;
  chart_config: PlotlyFigure;
  rows_json?: any[][];
  created_at?: string;
}

interface PinnedChartsProps {
  sessionId: string;
  refreshTrigger?: number;
}

const TYPE_BADGE: Record<string, string> = {
  bar: 'bg-blue-50 text-blue-700',
  line: 'bg-green-50 text-green-700',
  pie: 'bg-amber-50 text-amber-700',
  scatter: 'bg-purple-50 text-purple-700',
};

export function PinnedCharts({ sessionId, refreshTrigger }: PinnedChartsProps) {
  const [pins, setPins] = useState<PinnedChart[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<PinnedChart | null>(null);

  const loadPins = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/pins?session_id=${encodeURIComponent(sessionId)}`);
      if (res.ok) {
        const data = await res.json();
        setPins(data);
      }
    } catch {
      // silently fail — pins are non-critical
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadPins();
  }, [loadPins, refreshTrigger]);

  const handleDelete = async (id: number) => {
    try {
      await fetch(`/api/pins/${id}`, { method: 'DELETE' });
      setPins((prev) => prev.filter((p) => p.id !== id));
      if (expanded?.id === id) setExpanded(null);
    } catch {
      // ignore
    }
  };

  if (loading && pins.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">Loading pinned charts…</div>
    );
  }

  if (pins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <Pin className="mb-3 opacity-30" size={32} />
        <p className="text-sm text-muted-foreground">
          No pinned charts yet. Pin a chart from the chat.
        </p>
      </div>
    );
  }

  const getFigure = (pin: PinnedChart): PlotlyFigure => {
    const cfg = pin.chart_config;
    if (cfg && Array.isArray(cfg.data)) return cfg;
    return { data: [], layout: {} };
  };

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
        {pins.map((pin, idx) => {
          const figure = getFigure(pin);
          const badgeClass = TYPE_BADGE[pin.chart_type] ?? 'bg-gray-100 text-gray-600';
          return (
            <div
              key={pin.id}
              className="group relative border rounded-lg bg-card hover:shadow-md transition-shadow animate-fade-in-up"
              style={{ animationDelay: `${idx * 60}ms` }}
            >
              {/* Hover action buttons */}
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                <button
                  onClick={() => setExpanded(pin)}
                  className="p-1.5 rounded bg-background/80 backdrop-blur-sm border hover:bg-accent text-muted-foreground hover:text-foreground shadow-sm"
                  title="Expand"
                >
                  <Expand size={13} />
                </button>
                <button
                  onClick={() => handleDelete(pin.id)}
                  className="p-1.5 rounded bg-background/80 backdrop-blur-sm border hover:bg-destructive/10 text-muted-foreground hover:text-destructive shadow-sm"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="p-3">
                <p className="text-sm font-medium text-foreground line-clamp-3 mb-2 pr-16">
                  {pin.question}
                </p>

                {figure.data.length > 0 ? (
                  <div className="pointer-events-none">
                    <ChartRenderer
                      figure={figure}
                      height={200}
                      showToolbar={false}
                    />
                  </div>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground bg-muted/30 rounded">
                    {pin.chart_type.toUpperCase()} chart
                  </div>
                )}

                <div className="mt-2 flex items-center justify-between">
                  <span className={`text-xs px-1.5 py-0.5 rounded capitalize font-medium ${badgeClass}`}>
                    {pin.chart_type}
                  </span>
                  {pin.created_at && (
                    <span className="text-xs text-muted-foreground">
                      {new Date(pin.created_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Expand modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm bg-black/60 p-4"
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

            {(() => {
              const fig = getFigure(expanded);
              return fig.data.length > 0 ? (
                <ChartRenderer figure={fig} height={400} showToolbar={true} />
              ) : (
                <div className="h-48 flex items-center justify-center text-muted-foreground">
                  No chart data
                </div>
              );
            })()}

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
