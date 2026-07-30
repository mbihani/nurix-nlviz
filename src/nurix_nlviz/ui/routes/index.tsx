import { createFileRoute } from '@tanstack/react-router';
import { useState, useCallback, useRef } from 'react';
import { Pin, MessageCircle, X, Moon, Sun, Filter, XCircle } from 'lucide-react';
import { APP_TITLE, APP_SUBTITLE, PRIMARY_COLOR, LOGO_URL } from '../config/branding';
import { useGenieChat, type Message, type ChartEvent } from '../hooks/useGenieChat';
import { ChatPanel } from '../components/ChatPanel';
import { PinnedCharts } from '../components/PinnedCharts';

const FILTER_OPTIONS = {
  product: ['All', 'DesignPro Pro', 'DesignPro Free', 'DesignPro Enterprise'],
  feature_area: ['All', 'export', 'ui', 'performance', 'collaboration', 'api', 'mobile', 'pricing', 'onboarding'],
  ai_category: ['All', 'bug_report', 'feature_request', 'general_feedback', 'praise'],
} as const;

type FilterKey = keyof typeof FILTER_OPTIONS;

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
const MAX_PANEL_W = 640;
const DEFAULT_PANEL_W = 420;

function App() {
  const sessionId = getOrCreateSessionId();
  const { messages, isStreaming, sendMessage, stop } = useGenieChat(sessionId);
  const [pinnedMsgIds, setPinnedMsgIds] = useState<Set<string>>(new Set());
  const [pinRefresh, setPinRefresh] = useState(0);
  const [pinCount, setPinCount] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_W);
  const [dark, setDark] = useState(false);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  // Filter bar state
  const [activeFilters, setActiveFilters] = useState<Record<FilterKey, string>>({
    product: 'All',
    feature_area: 'All',
    ai_category: 'All',
  });
  const [filterOverrides, setFilterOverrides] = useState<Map<number, string>>(new Map());
  const [isFiltering, setIsFiltering] = useState(false);

  // Track pin IDs for filter targeting
  const [pinnedDbIds, setPinnedDbIds] = useState<number[]>([]);

  // Badge: count new pins since drawer was last opened
  const [newPinCount, setNewPinCount] = useState(0);

  const toggleDark = () => {
    setDark((v) => {
      const next = !v;
      document.documentElement.classList.toggle('dark', next);
      return next;
    });
  };

  const doPinChart = useCallback(
    async (chartHtml: string, sql: string | null | undefined, question: string) => {
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
            x: offset,
            y: offset,
            width: 600,
            height: 400,
          }),
        });
        if (res.ok) {
          const pin = await res.json();
          if (pin?.id) {
            setPinnedDbIds((prev) => [...prev, pin.id]);
          }
        }
      } catch {
        // non-critical
      }
    },
    [sessionId, pinnedDbIds],
  );

  const handlePinChart = useCallback(
    async (msg: Message) => {
      if (!msg.chart || pinnedMsgIds.has(msg.id)) return;

      const question =
        msg.content ||
        messages.find((_, i) => messages[i + 1]?.id === msg.id)?.content ||
        'Pinned chart';

      await doPinChart(msg.chart.html, msg.sql || msg.chart.sql, question);

      setPinnedMsgIds((prev) => new Set([...prev, msg.id]));
      setPinRefresh((n) => n + 1);
      setPinCount((n) => n + 1);
      setNewPinCount((n) => n + 1);
    },
    [sessionId, messages, pinnedMsgIds, doPinChart],
  );

  const handlePinChartEvent = useCallback(
    async (msg: Message, event: ChartEvent, idx: number) => {
      const key = `${msg.id}-${idx}`;
      if (pinnedMsgIds.has(key)) return;

      const question = event.title || msg.content || `Chart ${idx + 1}`;
      await doPinChart(event.html, event.sql, question);

      setPinnedMsgIds((prev) => new Set([...prev, key]));
      setPinRefresh((n) => n + 1);
      setPinCount((n) => n + 1);
      setNewPinCount((n) => n + 1);
    },
    [pinnedMsgIds, doPinChart],
  );

  const applyFilter = useCallback(async (filters: Record<FilterKey, string>, pinIds: number[]) => {
    const activeEntries = Object.entries(filters).filter(([, v]) => v !== 'All') as [FilterKey, string][];
    if (activeEntries.length === 0 || pinIds.length === 0) {
      setFilterOverrides(new Map());
      return;
    }
    setIsFiltering(true);
    try {
      // Apply filters one at a time for each active dimension
      let currentIds = pinIds;
      const newOverrides = new Map<number, string>();
      for (const [col, val] of activeEntries) {
        const res = await fetch('/api/filter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, filter_col: col, filter_val: val, pin_ids: currentIds }),
        });
        if (res.ok) {
          const data: { pin_id: number; chart_html: string }[] = await res.json();
          data.forEach((d) => newOverrides.set(d.pin_id, d.chart_html));
        }
      }
      setFilterOverrides(newOverrides);
    } catch {
      // silently fail
    } finally {
      setIsFiltering(false);
    }
  }, [sessionId]);

  const handleFilterChange = useCallback((key: FilterKey, value: string) => {
    const next = { ...activeFilters, [key]: value };
    setActiveFilters(next);
    applyFilter(next, pinnedDbIds);
  }, [activeFilters, pinnedDbIds, applyFilter]);

  const clearFilters = useCallback(() => {
    setActiveFilters({ product: 'All', feature_area: 'All', ai_category: 'All' });
    setFilterOverrides(new Map());
  }, []);

  // Resize panel by dragging its left edge
  const startPanelResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const origW = panelWidthRef.current;

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
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

  const handleOpenChat = () => {
    setChatOpen(true);
    setNewPinCount(0);
  };

  return (
    <div className="flex flex-col h-screen bg-background overflow-hidden">
      {/* Header */}
      <header
        className="flex items-center justify-between px-4 py-3 border-b shrink-0 bg-card"
        style={{ borderBottomColor: 'var(--color-border)' }}
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

        <div className="flex items-center gap-2">
          {/* Pin count badge */}
          {pinCount > 0 && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Pin size={11} />
              <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                {pinCount}
              </span>
            </div>
          )}
          <span className="text-xs text-muted-foreground hidden sm:block">
            Drag &amp; resize charts on the canvas
          </span>
          <button
            onClick={toggleDark}
            className="p-1.5 rounded border hover:bg-accent text-muted-foreground hover:text-foreground"
            title={dark ? 'Light mode' : 'Dark mode'}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </header>

      {/* Full-width canvas */}
      <div className={`flex-1 overflow-auto relative flex flex-col ${chatOpen ? 'pointer-events-none' : ''}`}>
        {/* Filter Bar — only visible when there are pinned charts */}
        {pinCount > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 border-b bg-card shrink-0 flex-wrap">
            <Filter size={13} className="text-muted-foreground shrink-0" />
            {(Object.entries(FILTER_OPTIONS) as [FilterKey, readonly string[]][]).map(([key, opts]) => (
              <div key={key} className="flex items-center gap-1.5">
                <label className="text-xs text-muted-foreground capitalize">{key.replace('_', ' ')}:</label>
                <select
                  value={activeFilters[key]}
                  onChange={(e) => handleFilterChange(key, e.target.value)}
                  disabled={isFiltering}
                  className="text-xs rounded border border-input bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                >
                  {opts.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </div>
            ))}
            {Object.values(activeFilters).some((v) => v !== 'All') && (
              <button
                onClick={clearFilters}
                disabled={isFiltering}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <XCircle size={13} />
                Clear filters
              </button>
            )}
            {isFiltering && <span className="text-xs text-muted-foreground animate-pulse">Updating charts…</span>}
          </div>
        )}
        <div className="flex-1 overflow-auto relative">
          <PinnedCharts sessionId={sessionId} refreshTrigger={pinRefresh} externalHtmlOverrides={filterOverrides} />
        </div>
      </div>

      {/* Floating "Ask Genie 💬" button */}
      {!chatOpen && (
        <button
          onClick={handleOpenChat}
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-full shadow-lg text-white font-medium text-sm transition-transform hover:scale-105 active:scale-95"
          style={{ backgroundColor: PRIMARY_COLOR }}
        >
          <MessageCircle size={18} />
          Ask Genie 💬
          {newPinCount > 0 && (
            <span
              className="ml-1 bg-white text-xs font-bold rounded-full px-1.5 py-0.5"
              style={{ color: PRIMARY_COLOR }}
            >
              {newPinCount}
            </span>
          )}
        </button>
      )}

      {/* Slide-in chat drawer from right */}
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

          {/* Drawer content */}
          <div className="flex flex-col flex-1 bg-background border-l overflow-hidden">
            {/* Drawer header */}
            <div
              className="flex items-center justify-between px-3 py-2 border-b shrink-0 bg-card"
              style={{ borderBottomColor: 'var(--color-border)' }}
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
                onPinChartEvent={handlePinChartEvent}
                pinnedIds={pinnedMsgIds}
                sessionId={sessionId}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
