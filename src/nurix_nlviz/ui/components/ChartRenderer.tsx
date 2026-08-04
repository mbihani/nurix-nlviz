interface ChartRendererProps {
  html: string;
  height?: number;
}

export function ChartRenderer({ html, height = 320 }: ChartRendererProps) {
  if (!html) {
    return (
      <div className="flex items-center justify-center h-48 text-sm" style={{ color: '#64748B' }}>
        No data to display
      </div>
    );
  }
  return (
    <iframe
      srcDoc={html}
      sandbox="allow-scripts"
      style={{ width: '100%', height, border: 'none', display: 'block', background: 'transparent' }}
      title="Chart"
    />
  );
}
