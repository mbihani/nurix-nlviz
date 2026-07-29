import { useState } from 'react';
import Plot from 'react-plotly.js';
import { ChartEditor } from './ChartEditor';

interface ChartRendererProps {
  figure: { data: any[]; layout: any };
  columns: Array<{ name: string; type?: string }>;
  rows: any[][];
  height?: number;
}

export function ChartRenderer({ figure, columns, rows, height = 320 }: ChartRendererProps) {
  const [showEditor, setShowEditor] = useState(false);
  const [currentFigure, setCurrentFigure] = useState(figure);

  if (!figure || !figure.data || figure.data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        No data to display
      </div>
    );
  }

  return (
    <div style={{ width: '100%' }}>
      <Plot
        data={currentFigure.data}
        layout={{
          ...currentFigure.layout,
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          autosize: true,
          height,
        }}
        config={{ displayModeBar: true, responsive: true }}
        style={{ width: '100%' }}
        useResizeHandler
      />
      <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
        <button
          onClick={() => setShowEditor(true)}
          className="text-xs px-2 py-1 rounded border hover:bg-accent"
        >
          Edit Chart ✏️
        </button>
      </div>
      {showEditor && (
        <ChartEditor
          figure={currentFigure}
          columns={columns}
          rows={rows}
          onUpdate={(updated) => setCurrentFigure(updated)}
          onClose={() => setShowEditor(false)}
        />
      )}
    </div>
  );
}
