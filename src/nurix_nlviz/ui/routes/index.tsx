import { createFileRoute } from '@tanstack/react-router';
import { useState, useCallback } from 'react';
import { Pin, Moon, Sun } from 'lucide-react';
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

function App() {
  const sessionId = getOrCreateSessionId();
  const { messages, isStreaming, sendMessage, stop } = useGenieChat(sessionId);
  const [pinnedMsgIds, setPinnedMsgIds] = useState<Set<string>>(new Set());
  const [pinRefresh, setPinRefresh] = useState(0);
  const [showPins, setShowPins] = useState(true);
  const [pinCount, setPinCount] = useState(0);
  const [dark, setDark] = useState(false);

  const toggleDark = () => {
    setDark((v) => {
      const next = !v;
      document.documentElement.classList.toggle('dark', next);
      return next;
    });
  };

  const handlePinChart = useCallback(
    async (msg: Message) => {
      if (!msg.chart || pinnedMsgIds.has(msg.id)) return;

      try {
        await fetch('/api/pins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            question: msg.content || messages.find((_, i) => messages[i + 1]?.id === msg.id)?.content || 'Pinned chart',
            sql_query: msg.sql || msg.chart.sql || null,
            chart_type: msg.chart.figure?.data?.[0]?.type ?? 'plotly',
            chart_config: msg.chart.figure,
            rows_json: (msg.chart.rows as any[]) ?? null,
          }),
        });
      } catch {
        // If direct pin endpoint fails, the agent pin_chart tool already handles it
      }

      setPinnedMsgIds((prev) => new Set([...prev, msg.id]));
      setPinRefresh((n) => n + 1);
      setPinCount((n) => n + 1);
    },
    [sessionId, messages, pinnedMsgIds],
  );

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="bg-card border-b shadow-sm py-3 px-6 flex items-center justify-between shrink-0">
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPins((v) => !v)}
            className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border hover:bg-accent"
          >
            <Pin size={12} />
            {showPins ? 'Hide' : 'Show'} Pins
          </button>
          <button
            onClick={toggleDark}
            className="p-1.5 rounded border hover:bg-accent text-muted-foreground hover:text-foreground"
            title={dark ? 'Light mode' : 'Dark mode'}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </header>

      {/* Main split layout */}
      <div className="flex flex-1 min-h-0">
        {/* Chat Panel */}
        <div className={`flex flex-col min-h-0 ${showPins ? 'w-[52%]' : 'flex-1'}`}>
          <ChatPanel
            messages={messages}
            isStreaming={isStreaming}
            onSend={sendMessage}
            onStop={stop}
            onPinChart={handlePinChart}
            pinnedIds={pinnedMsgIds}
          />
        </div>

        {/* Divider */}
        {showPins && <div className="w-px bg-border shrink-0" />}

        {/* Pins Panel */}
        {showPins && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0">
              <Pin size={11} className="text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">Pinned Charts</span>
              {pinCount > 0 && (
                <span className="ml-1 text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                  {pinCount}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              <PinnedCharts sessionId={sessionId} refreshTrigger={pinRefresh} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
