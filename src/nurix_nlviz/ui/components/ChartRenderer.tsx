interface ChartRendererProps {
  html: string;
  height?: number;
}

export function ChartRenderer({ html, height = 320 }: ChartRendererProps) {
  if (!html) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        No data to display
      </div>
    );
  }
  return (
    <iframe
      srcDoc={html}
      sandbox="allow-scripts"
      style={{ width: '100%', height, border: 'none', display: 'block' }}
      title="Chart"
    />
  );
}
