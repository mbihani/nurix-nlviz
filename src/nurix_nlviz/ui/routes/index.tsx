import { createFileRoute } from '@tanstack/react-router';
import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { Pin, MessageSquare, X, Sparkles, BarChart3 } from 'lucide-react';
import { APP_TITLE, APP_SUBTITLE } from '../config/branding';
import { useGenieChat, type Message, type ChartEvent } from '../hooks/useGenieChat';
import { ChatPanel } from '../components/ChatPanel';
import { BENTO_GRID, getGridMetrics, PinnedCharts, rectsOverlap, Y_STEP } from '../components/PinnedCharts';

export const Route = createFileRoute('/')({
  component: App,
});

function getOrCreateSessionId(): string {
  const key = 'nurix-nlviz-session-id';
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
}

const MIN_PANEL_W = 340;
const MAX_PANEL_W = 660;
const DEFAULT_PANEL_W = 440;
const GRID_ROW = BENTO_GRID.rowHeight;
const GRID_GUTTER = BENTO_GRID.gutter;
const GRID_Y_STEP = Y_STEP;
const DEFAULT_COL_SPAN = 5;
const DEFAULT_ROW_SPAN = 5;
const DEFAULT_CARD_H = DEFAULT_ROW_SPAN * GRID_ROW + (DEFAULT_ROW_SPAN - 1) * GRID_GUTTER;
const CANVAS_PADDING = 12;

interface PinLayout { id: number; x: number; y: number; width: number; height: number }

/**
 * Pick the first grid slot whose rect overlaps no existing pinned card.
 *
 * Scans row-major (left-to-right, then down) over the CURRENT pins' real rects —
 * not a count — so placement stays correct after deletes, drags and resizes.
 * `canvasWidth` clamps the rightmost column so a card is never dropped
 * off-screen; a card wider than the canvas still starts at x=0.
 */
function findFreeGridSlot(pins: PinLayout[], canvasWidth: number) {
  const { columnWidth, xStep } = getGridMetrics(canvasWidth);
  const defaultCardW = DEFAULT_COL_SPAN * columnWidth + (DEFAULT_COL_SPAN - 1) * GRID_GUTTER;
  const maxX = Math.max(0, canvasWidth - defaultCardW);
  const lastCol = Math.floor(maxX / xStep);

  for (let row = 0; row < 200; row += 1) {
    for (let col = 0; col <= lastCol; col += 1) {
      const candidate = { x: col * xStep, y: row * GRID_Y_STEP, width: defaultCardW, height: DEFAULT_CARD_H };
      if (!pins.some((pin) => rectsOverlap(candidate, pin))) return candidate;
    }
  }
  // Exhausted the scan — drop it below everything rather than on top of a card.
  const lowest = pins.reduce((acc, p) => Math.max(acc, p.y + p.height), 0);
  return { x: 0, y: lowest + GRID_GUTTER, width: defaultCardW, height: DEFAULT_CARD_H };
}

function App() {
  const sessionId = getOrCreateSessionId();
  const { messages, isStreaming, sendMessage, stop } = useGenieChat(sessionId);
  const [pinnedMsgIds, setPinnedMsgIds] = useState<Set<string>>(new Set());
  const [pinRefresh, setPinRefresh] = useState(0);
  const [pinCount, setPinCount] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_W);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  const [newPinCount, setNewPinCount] = useState(0);

  // Live rects of the rendered cards, reported by PinnedCharts. Held in a ref so
  // placement always reads the current layout — a state snapshot captured in
  // doPinChart's closure goes stale after a drag/resize/delete.
  const pinLayoutsRef = useRef<PinLayout[]>([]);
  const handleLayoutsChange = useCallback((rects: PinLayout[]) => {
    pinLayoutsRef.current = rects;
  }, []);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(1);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let timer = 0;
    const measure = () => setCanvasWidth(Math.max(1, canvas.clientWidth - CANVAS_PADDING * 2));
    measure();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 80);
    });
    observer.observe(canvas);
    return () => { window.clearTimeout(timer); observer.disconnect(); };
  }, []);

  useEffect(() => {
    fetch(`/api/pins?session_id=${encodeURIComponent(sessionId)}`)
      .then(r => r.ok ? r.json() : [])
      .then((pins: PinLayout[]) => {
        if (pins.length > 0) {
          setPinCount(pins.length);
          pinLayoutsRef.current = pins;
        }
      }).catch(() => {});
  }, [sessionId]);

  const doPinChart = useCallback(async (chartHtml: string, sql: string | null | undefined, question: string) => {
    const slot = findFreeGridSlot(pinLayoutsRef.current, canvasWidth);
    try {
      const res = await fetch('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          question,
          sql_query: sql || null,
          chart_type: 'html',
          chart_config: chartHtml,
          rows_json: null,
          x: Math.round(slot.x),
          y: Math.round(slot.y),
          width: Math.round(slot.width),
          height: Math.round(slot.height),
        }),
      });
      if (!res.ok) return false;
      const pin = await res.json();
      // Record the new rect immediately: two pins issued back-to-back must not
      // both resolve to the same free slot before PinnedCharts re-reports.
      pinLayoutsRef.current = [...pinLayoutsRef.current, { id: pin.id, ...slot }];
      setPinCount(prev => prev + 1);
      setPinRefresh(prev => prev + 1);
      if (!chatOpen) setNewPinCount(prev => prev + 1);
      return true;
    } catch { return false; }
  }, [sessionId, chatOpen, canvasWidth]);

  const handlePinChart = useCallback((msg: Message) => {
    if (!msg.chart) return;
    // Use msg.id as the key to prevent double-pinning
    if (pinnedMsgIds.has(msg.id)) return;
    doPinChart(msg.chart.html, msg.sql, msg.content || msg.chart.title || 'Chart');
    setPinnedMsgIds(prev => new Set([...prev, msg.id]));
  }, [doPinChart, pinnedMsgIds]);

  const handlePinChartEvent = useCallback((msg: Message, event: ChartEvent, idx: number) => {
    // Compose a per-chart key so each chart in a multi-chart message can pin once
    const key = `${msg.id}:${idx}`;
    if (pinnedMsgIds.has(key)) return;
    doPinChart(event.html, msg.sql, msg.content || event.title || 'Chart');
    setPinnedMsgIds(prev => new Set([...prev, key]));
  }, [doPinChart, pinnedMsgIds]);

  const resizing = useRef(false);
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startW = panelWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = startX - ev.clientX;
      const newW = Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, startW + delta));
      setPanelWidth(newW); panelWidthRef.current = newW;
    };
    const onUp = () => { resizing.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#020617', fontFamily: "'Inter', system-ui, sans-serif", overflow: 'hidden' }}>
      {/* Header */}
      <header style={{ background: '#020617', borderBottom: '1px solid #1E293B', padding: '0 24px', height: '56px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, zIndex: 50 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '30px', height: '30px', background: '#0891B2', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <BarChart3 size={15} color="white" />
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, letterSpacing: '-0.01em', color: '#FFFFFF' }}>{APP_TITLE}</div>
            <div style={{ fontSize: '10px', color: '#64748B', marginTop: '-1px', letterSpacing: '0.02em' }}>{APP_SUBTITLE}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {pinCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'rgba(8,145,178,0.1)', border: '1px solid rgba(8,145,178,0.2)', borderRadius: '6px', padding: '3px 10px', fontSize: '12px', color: '#22D3EE', fontWeight: 500 }}>
              <Pin size={10} /><span style={{ color: '#FFFFFF', fontWeight: 600 }}>{pinCount}</span><span style={{ color: '#94A3B8' }}>pinned</span>
            </div>
          )}
        </div>
      </header>

      {/* Canvas */}
      <div ref={canvasRef} data-nlviz-canvas style={{ flex: 1, position: 'relative', overflowX: 'hidden', overflowY: 'auto', padding: CANVAS_PADDING, backgroundColor: '#020617', backgroundImage: 'linear-gradient(#0F172A 1px, transparent 1px), linear-gradient(90deg, #0F172A 1px, transparent 1px)', backgroundSize: `${getGridMetrics(canvasWidth).xStep}px ${GRID_Y_STEP}px` }}>
        {pinCount === 0 && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none', userSelect: 'none' }}>
            <div style={{ width: '60px', height: '60px', margin: '0 auto 20px', background: 'rgba(8,145,178,0.1)', border: '1px solid rgba(8,145,178,0.2)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sparkles size={26} style={{ color: '#22D3EE' }} />
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: 600, color: '#FFFFFF', margin: '0 0 10px' }}>Ask anything about your data</h2>
            <p style={{ color: '#64748B', fontSize: '13px', maxWidth: '300px', margin: '0 auto 24px' }}>Open the chat, ask a question in natural language, and pin visualizations to build your dashboard.</p>
            <button onClick={() => setChatOpen(true)} style={{ background: '#0891B2', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 22px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', pointerEvents: 'auto' }}>
              <MessageSquare size={14} /> Ask Genie
            </button>
          </div>
        )}
        <PinnedCharts sessionId={sessionId} canvasWidth={canvasWidth} refreshTrigger={pinRefresh} onLayoutsChange={handleLayoutsChange} />
      </div>

      {/* Floating Ask button */}
      {!chatOpen && (
        <button onClick={() => { setChatOpen(true); setNewPinCount(0); }} style={{ position: 'fixed', bottom: '28px', right: '28px', display: 'flex', alignItems: 'center', gap: '8px', background: '#0891B2', color: 'white', border: 'none', borderRadius: '8px', padding: '12px 22px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', zIndex: 40 }}>
          <MessageSquare size={15} /><span>Ask Genie</span>
          {newPinCount > 0 && <span style={{ background: '#22D3EE', color: 'white', borderRadius: '4px', fontSize: '10px', fontWeight: 700, padding: '1px 6px' }}>{newPinCount}</span>}
        </button>
      )}

      {/* Chat drawer */}
      {chatOpen && (
        <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: `${panelWidth}px`, background: '#020617', borderLeft: '1px solid #1E293B', zIndex: 50, display: 'flex', flexDirection: 'column' }}>
          <div onMouseDown={handleResizeMouseDown} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px', cursor: 'ew-resize', zIndex: 1 }} />
          <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(8,145,178,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(8,145,178,0.04)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '24px', height: '24px', background: '#0891B2', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Sparkles size={12} color="white" />
              </div>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#FFFFFF' }}>Genie Intelligence</span>
              <span className="badge-indigo">Beta</span>
            </div>
            <button onClick={() => setChatOpen(false)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(8,145,178,0.15)', borderRadius: '6px', color: '#64748B', cursor: 'pointer', width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={13} /></button>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ChatPanel messages={messages} isStreaming={isStreaming} onSend={sendMessage} onStop={stop} onPinChart={handlePinChart} onPinChartEvent={handlePinChartEvent} pinnedIds={pinnedMsgIds} sessionId={sessionId} />
          </div>
        </div>
      )}
    </div>
  );
}
