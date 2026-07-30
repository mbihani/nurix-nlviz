import Plot from 'react-plotly.js';

interface ChartRendererProps {
  figure: { data: any[]; layout: any };
  columns?: Array<{ name: string; type?: string }>;
  rows?: any[][];
  height?: number;
  showToolbar?: boolean;
}

export function ChartRenderer({ figure, height = 320, showToolbar = false }: ChartRendererProps) {
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
        data={figure.data}
        layout={{
          ...figure.layout,
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          autosize: true,
          height,
          font: { family: 'Inter, system-ui, sans-serif', size: 12 },
          margin: { t: 32, b: 40, l: 48, r: 16 },
        }}
        config={{ displayModeBar: showToolbar, responsive: true }}
        style={{ width: '100%' }}
        useResizeHandler
      />
    </div>
  );
}
