import { useState, useEffect, useCallback } from 'react';
import { Trash2, Pin, Expand, X } from 'lucide-react';
import { ChartRenderer } from './ChartRenderer';
import { CHART_COLORS } from '../config/branding';

interface PinnedChart {
  id: number;
  session_id: string;
  question: string;
  sql_query?: string;
  chart_type: string;
  chart_config: Record<string, string>;
  rows_json?: Record<string, unknown>[];
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
      <div className="text-sm text-muted-foreground text-center py-6 px-4">
        <Pin className="mx-auto mb-2 opacity-30" size={24} />
        No pinned charts yet. Pin a chart from the visualization panel.
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-3 p-3">
        {pins.map((pin) => (
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
                  onClick={() => handleDelete(pin.id)}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {pin.rows_json && pin.rows_json.length > 0 ? (
              <div className="pointer-events-none">
                <ChartRenderer
                  chartType={pin.chart_type}
                  config={pin.chart_config}
                  data={pin.rows_json}
                  height={140}
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

            {expanded.rows_json && expanded.rows_json.length > 0 ? (
              <ChartRenderer
                chartType={expanded.chart_type}
                config={expanded.chart_config}
                data={expanded.rows_json}
                height={320}
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
