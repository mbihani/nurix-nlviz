import { useState, useEffect, useCallback } from 'react';
import { Trash2, Pin, Expand, X } from 'lucide-react';
import Plot from 'react-plotly.js';
import { ChartEditor } from './ChartEditor';
import { CHART_COLORS } from '../config/branding';

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

export function PinnedCharts({ sessionId, refreshTrigger }: PinnedChartsProps) {
  const [pins, setPins] = useState<PinnedChart[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<PinnedChart | null>(null);
  const [editing, setEditing] = useState<PinnedChart | null>(null);

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

  const handleSaveEdit = async (pin: PinnedChart, updatedFigure: PlotlyFigure) => {
    try {
      const res = await fetch(`/api/pins/${pin.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart_config: updatedFigure }),
      });
      if (res.ok) {
        const updated = await res.json();
        setPins((prev) => prev.map((p) => (p.id === pin.id ? updated : p)));
        if (expanded?.id === pin.id) setExpanded(updated);
      }
    } catch {
      // ignore patch errors
    }
  };

  if (loading && pins.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">Loading pinned charts…</div>
    );
  }

  if (pins.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-6 px-4">
        <Pin className="mx-auto mb-2 opacity-30" size={24} />
        No pinned charts yet. Pin a chart from the visualization panel.
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
      <div className="grid grid-cols-1 gap-3 p-3">
        {pins.map((pin) => {
          const figure = getFigure(pin);
          return (
            <div
              key={pin.id}
              className="border rounded-lg bg-card p-3 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start justify-between mb-2 gap-2">
                <p className="text-xs font-medium text-foreground line-clamp-2 flex-1">
                  {pin.question}
                </p>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => setExpanded(pin)}
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                    title="Expand"
                  >
                    <Expand size={13} />
                  </button>
                  <button
                    onClick={() => setEditing(pin)}
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground text-xs"
                    title="Edit chart"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => handleDelete(pin.id)}
                    className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              {figure.data.length > 0 ? (
                <div className="pointer-events-none">
                  <Plot
                    data={figure.data}
                    layout={{
                      ...figure.layout,
                      paper_bgcolor: 'transparent',
                      plot_bgcolor: 'transparent',
                      autosize: true,
                      height: 140,
                      margin: { t: 20, b: 30, l: 40, r: 10 },
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%' }}
                    useResizeHandler
                  />
                </div>
              ) : (
                <div className="h-24 flex items-center justify-center text-xs text-muted-foreground bg-muted/30 rounded">
                  {pin.chart_type.toUpperCase()} chart
                </div>
              )}

              <div className="mt-1 flex items-center justify-between">
                <span
                  className="text-xs px-1.5 py-0.5 rounded text-white capitalize"
                  style={{ backgroundColor: CHART_COLORS[1] }}
                >
                  {pin.chart_type}
                </span>
                {pin.created_at && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(pin.created_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          );
        })}
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

            {(() => {
              const fig = getFigure(expanded);
              return fig.data.length > 0 ? (
                <Plot
                  data={fig.data}
                  layout={{
                    ...fig.layout,
                    paper_bgcolor: 'transparent',
                    plot_bgcolor: 'transparent',
                    autosize: true,
                    height: 320,
                  }}
                  config={{ displayModeBar: true, responsive: true }}
                  style={{ width: '100%' }}
                  useResizeHandler
                />
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

      {/* Edit modal */}
      {editing && (
        <ChartEditor
          figure={getFigure(editing)}
          columns={[]}
          rows={[]}
          onUpdate={(updatedFigure) => {
            handleSaveEdit(editing, updatedFigure);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
