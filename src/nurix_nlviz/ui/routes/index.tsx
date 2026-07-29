import { createFileRoute } from '@tanstack/react-router';
import { useState, useCallback, useRef, useEffect } from 'react';
import { Pin, MessageCircle, X } from 'lucide-react';
import { APP_TITLE, APP_SUBTITLE, PRIMARY_COLOR, LOGO_URL } from '../config/branding';
import { useGenieChat, type Message } from '../hooks/useGenieChat';
import { ChatPanel } from '../components/ChatPanel';
import { PinnedCharts } from '../components/PinnedCharts';

export const Route = createFileRoute('/')({
  component: App,
});

function getOrCreateSessionId(): string {
  const key = 'nurix-nlviz-session-id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

const MIN_PANEL_W = 320;
const MAX_PANEL_W = 600;
const DEFAULT_PANEL_W = 420;

function App() {
  const sessionId = getOrCreateSessionId();
  const { messages, isStreaming, sendMessage, stop } = useGenieChat(sessionId);
  const [pinnedMsgIds, setPinnedMsgIds] = useState<Set<string>>(new Set());
  const [pinRefresh, setPinRefresh] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_W);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  // Track new pins count to badge the button
  const [newPinCount, setNewPinCount] = useState(0);

  const handlePinChart = useCallback(
    async (msg: Message, refinedHtml?: string) => {
      if (!msg.htmlReport) return;

      const html = refinedHtml ?? msg.htmlReport.html;
      const question =
        msg.htmlReport.question ||
        messages.find((_m, i) => messages[i + 1]?.id === msg.id)?.content ||
        'Pinned chart';

      try {
        await fetch('/api/pins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            question,
            sql_query: msg.sql || msg.htmlReport.sql || null,
            chart_type: 'html',
            chart_config: {
              html,
              columns: msg.htmlReport.columns,
              rows: msg.htmlReport.rows.slice(0, 50),
            },
            rows_json: msg.htmlReport.rows.slice(0, 50) as any[],
          }),
        });
      } catch {
        // silently fall back to local pin
      }

      setPinnedMsgIds((prev) => new Set([...prev, msg.id]));
      setPinRefresh((n) => n + 1);
      setNewPinCount((n) => n + 1);
    },
    [sessionId, messages],
  );

  // Resize panel by dragging its left edge
  const startPanelResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const origW = panelWidthRef.current;

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // dragging left = wider
      const nw = Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, origW + delta));
      setPanelWidth(nw);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Clear badge when panel opens
  const handleOpenChat = () => {
    setChatOpen(true);
    setNewPinCount(0);
  };

  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden">
      {/* Header */}
      <header
        className="flex items-center justify-between px-4 py-3 border-b shrink-0"
        style={{ borderBottomColor: '#e5e7eb' }}
      >
        <div className="flex items-center gap-3">
          {LOGO_URL ? (
            <img src={LOGO_URL} alt="logo" className="h-7 w-auto" />
          ) : (
            <div
              className="h-7 w-7 rounded flex items-center justify-center text-white text-xs font-bold"
              style={{ backgroundColor: PRIMARY_COLOR }}
            >
              N
            </div>
          )}
          <div>
            <h1 className="font-semibold text-sm text-foreground leading-none">{APP_TITLE}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">{APP_SUBTITLE}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Pin size={11} />
          <span>Drag &amp; resize pinned charts on the canvas</span>
        </div>
      </header>

      {/* Canvas — full width */}
      <div className="flex-1 overflow-auto relative">
        <PinnedCharts sessionId={sessionId} refreshTrigger={pinRefresh} />
      </div>

      {/* Floating "Ask Genie" button */}
      {!chatOpen && (
        <button
          onClick={handleOpenChat}
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-full shadow-lg text-white font-medium text-sm transition-transform hover:scale-105 active:scale-95"
          style={{ backgroundColor: PRIMARY_COLOR }}
        >
          <MessageCircle size={18} />
          Ask Genie
          {newPinCount > 0 && (
            <span className="ml-1 bg-white text-xs font-bold rounded-full px-1.5 py-0.5" style={{ color: PRIMARY_COLOR }}>
              {newPinCount}
            </span>
          )}
        </button>
      )}

      {/* Floating chat panel */}
      {chatOpen && (
        <div
          className="fixed top-0 right-0 bottom-0 z-40 flex shadow-2xl"
          style={{ width: panelWidth }}
        >
          {/* Drag-to-resize handle on left edge */}
          <div
            className="w-1.5 h-full cursor-ew-resize bg-border/40 hover:bg-primary/30 transition-colors shrink-0"
            onMouseDown={startPanelResize}
          />

          {/* Panel content */}
          <div className="flex flex-col flex-1 bg-background border-l overflow-hidden">
            {/* Panel header */}
            <div
              className="flex items-center justify-between px-3 py-2 border-b shrink-0"
              style={{ borderBottomColor: '#e5e7eb' }}
            >
              <div className="flex items-center gap-2">
                <MessageCircle size={14} style={{ color: PRIMARY_COLOR }} />
                <span className="text-sm font-semibold text-foreground">Ask Genie</span>
              </div>
              <button
                onClick={() => setChatOpen(false)}
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                title="Close"
              >
                <X size={16} />
              </button>
            </div>

            {/* Chat UI */}
            <div className="flex-1 min-h-0">
              <ChatPanel
                messages={messages}
                isStreaming={isStreaming}
                onSend={sendMessage}
                onStop={stop}
                onPinChart={handlePinChart}
                pinnedIds={pinnedMsgIds}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
