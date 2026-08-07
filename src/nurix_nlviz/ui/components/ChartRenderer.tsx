import { useMemo } from 'react';
import { withFittedChrome } from '../lib/chartFrame';

interface ChartRendererProps {
  html: string;
  /**
   * Explicit pixel height. Omit to fill the parent, which is what a resizable
   * pinned card wants — the chart then tracks the card instead of a fixed number.
   */
  height?: number | string;
  title?: string;
  /**
   * Hide the generated document's own heading. Set where the surrounding chrome
   * already shows the question (pinned cards, expand modal) so the chart is not
   * topped by a redundant second header.
   */
  hideTitle?: boolean;
  /** Temporarily let a captured card gesture pass over the iframe uninterrupted. */
  isInteracting?: boolean;
}

export function ChartRenderer({ html, height = '100%', title = 'Visualization', hideTitle = false, isInteracting = false }: ChartRendererProps) {
  // Inject the fit chrome (viewport-locked CSS + Chart.js option patch) so the
  // chart scales to the box and never scrolls. Done here rather than in the
  // agent so charts already stored in Lakebase are fixed on render.
  const framedHtml = useMemo(() => withFittedChrome(html, { hideTitle }), [html, hideTitle]);

  if (!html) {
    return (
      <div className="flex items-center justify-center h-48 text-sm" style={{ color: '#64748B' }}>
        No data to display
      </div>
    );
  }
  return (
    <iframe
      srcDoc={framedHtml}
      sandbox="allow-scripts"
      scrolling="no"
      style={{
        width: '100%',
        height,
        display: 'block',
        border: 'none',
        background: 'transparent',
        overflow: 'hidden',
        pointerEvents: isInteracting ? 'none' : 'auto',
      }}
      title={title}
    />
  );
}
