import { createFileRoute } from '@tanstack/react-router';
import { useState, useCallback, useRef, useEffect } from 'react';
import { Pin, MessageSquare, X, Sparkles, BarChart3 } from 'lucide-react';
import { APP_TITLE, APP_SUBTITLE } from '../config/branding';
import { useGenieChat, type Message, type ChartEvent } from '../hooks/useGenieChat';
import { ChatPanel } from '../components/ChatPanel';
import { PinnedCharts } from '../components/PinnedCharts';

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
  const [pinnedDbIds, setPinnedDbIds] = useState<number[]>([]);
  const [newPinCount, setNewPinCount] = useState(0);

  useEffect(() => {
    fetch(`/api/pins?session_id=${encodeURIComponent(sessionId)}`)
      .then(r => r.ok ? r.json() : [])
      .then((pins: { id: number }[]) => {
        if (pins.length > 0) {
          setPinCount(pins.length);
          setPinnedDbIds(pins.map(p => p.id));
        }
      }).catch(() => {});
  }, [sessionId]);

  const doPinChart = useCallback(async (chartHtml: string, sql: string | null | undefined, question: string) => {
    const offset = pinnedDbIds.length * 20;
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
          x: offset, y: offset, width: 480, height: 320,
        }),
      });
      if (!res.ok) return false;
      const pin = await res.json();
      setPinnedDbIds(prev => [...prev, pin.id]);
      setPinCount(prev => prev + 1);
      setPinRefresh(prev => prev + 1);
      if (!chatOpen) setNewPinCount(prev => prev + 1);
      return true;
    } catch { return false; }
  }, [sessionId, pinnedDbIds.length, chatOpen]);

  const handlePinChart = useCallback((msg: Message) => {
    if (!msg.chart) return;
    doPinChart(msg.chart.html, msg.sql, msg.content || msg.chart.title || 'Chart');
  }, [doPinChart]);

  const handlePinChartEvent = useCallback((msg: Message, event: ChartEvent, _idx: number) => {
    doPinChart(event.html, msg.sql, msg.content || event.title || 'Chart');
  }, [doPinChart]);

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0A0A12', fontFamily: "'Inter', system-ui, sans-serif", overflow: 'hidden' }}>
      {/* Header */}
      <header style={{ background: 'linear-gradient(90deg, #0D0D1A 0%, #111128 100%)', borderBottom: '1px solid rgba(99,102,241,0.15)', padding: '0 24px', height: '56px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, zIndex: 50 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '30px', height: '30px', background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 14px rgba(99,102,241,0.45)' }}>
            <BarChart3 size={15} color="white" />
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, letterSpacing: '-0.01em', background: 'linear-gradient(135deg, #818CF8 0%, #60A5FA 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{APP_TITLE}</div>
            <div style={{ fontSize: '10px', color: '#64748B', marginTop: '-1px', letterSpacing: '0.02em' }}>{APP_SUBTITLE}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {pinCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '20px', padding: '3px 10px', fontSize: '12px', color: '#60A5FA', fontWeight: 500 }}>
              <Pin size={10} /><span>{pinCount} pinned</span>
            </div>
          )}
        </div>
      </header>

      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative', overflow: 'auto', background: '#0A0A12', backgroundImage: 'radial-gradient(circle, rgba(99,102,241,0.06) 1px, transparent 1px)', backgroundSize: '28px 28px', pointerEvents: chatOpen ? 'none' : 'auto' }}>
        {pinCount === 0 && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none', userSelect: 'none' }}>
            <div style={{ width: '60px', height: '60px', margin: '0 auto 20px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sparkles size={26} style={{ color: '#818CF8' }} />
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: 600, marginBottom: '10px', background: 'linear-gradient(135deg, #818CF8 0%, #60A5FA 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', margin: '0 0 10px' }}>Ask anything about your data</h2>
            <p style={{ color: '#64748B', fontSize: '13px', maxWidth: '300px', margin: '0 auto 24px' }}>Open the chat, ask a question in natural language, and pin visualizations to build your dashboard.</p>
            <button onClick={() => setChatOpen(true)} style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', color: 'white', border: 'none', borderRadius: '24px', padding: '10px 22px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '7px', boxShadow: '0 4px 20px rgba(99,102,241,0.4)', pointerEvents: 'auto' }}>
              <MessageSquare size={14} /> Ask Genie
            </button>
          </div>
        )}
        <PinnedCharts sessionId={sessionId} refreshTrigger={pinRefresh} />
      </div>

      {/* Floating Ask button */}
      {!chatOpen && (
        <button onClick={() => { setChatOpen(true); setNewPinCount(0); }} style={{ position: 'fixed', bottom: '28px', right: '28px', display: 'flex', alignItems: 'center', gap: '8px', background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', color: 'white', border: 'none', borderRadius: '28px', padding: '12px 22px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 20px rgba(99,102,241,0.45)', zIndex: 40 }}>
          <MessageSquare size={15} /><span>Ask Genie</span>
          {newPinCount > 0 && <span style={{ background: '#22C55E', color: 'white', borderRadius: '9999px', fontSize: '10px', fontWeight: 700, padding: '1px 6px' }}>{newPinCount}</span>}
        </button>
      )}

      {/* Chat drawer */}
      {chatOpen && (
        <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: `${panelWidth}px`, background: '#0D0D1A', borderLeft: '1px solid rgba(99,102,241,0.2)', boxShadow: '-8px 0 40px rgba(0,0,0,0.7)', zIndex: 50, display: 'flex', flexDirection: 'column' }}>
          <div onMouseDown={handleResizeMouseDown} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px', cursor: 'ew-resize', zIndex: 1 }} />
          <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(99,102,241,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(99,102,241,0.04)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '24px', height: '24px', background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Sparkles size={12} color="white" />
              </div>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#F8FAFC' }}>Genie Intelligence</span>
              <span className="badge-indigo">Beta</span>
            </div>
            <button onClick={() => setChatOpen(false)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: '6px', color: '#64748B', cursor: 'pointer', width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={13} /></button>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ChatPanel messages={messages} isStreaming={isStreaming} onSend={sendMessage} onStop={stop} onPinChart={handlePinChart} onPinChartEvent={handlePinChartEvent} pinnedIds={pinnedMsgIds} sessionId={sessionId} />
          </div>
        </div>
      )}
    </div>
  );
}
