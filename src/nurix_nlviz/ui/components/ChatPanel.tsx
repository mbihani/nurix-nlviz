import { useEffect, useRef, useState } from 'react';
import { Send, Square, Database, ChevronDown, ChevronUp, Sparkles, Microscope } from 'lucide-react';
import type { Message, ChartEvent } from '../hooks/useGenieChat';
import { ChartRenderer } from './ChartRenderer';
import { MarkdownText } from './MarkdownText';

export const SUGGESTED = [
  'What are the top feature areas by number of negative reviews?',
  'Show me sentiment trends over time for Pro users',
  'Which country has the highest average urgency score?',
];

interface ChatPanelProps {
  messages: Message[];
  isStreaming: boolean;
  onSend: (q: string, deepResearch?: boolean) => void;
  onStop: () => void;
  onPinChart: (msg: Message) => void;
  onPinChartEvent?: (msg: Message, event: ChartEvent, idx: number) => void;
  pinnedIds: Set<string>;
  sessionId: string;
}

export function ChatPanel({
  messages,
  isStreaming,
  onSend,
  onStop,
  onPinChart,
  onPinChartEvent,
  pinnedIds,
  sessionId,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [deepResearch, setDeepResearch] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || isStreaming) return;
    setInput('');
    onSend(q, deepResearch);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center pt-8">
            <p className="text-sm mb-4" style={{ color: '#64748B' }}>
              Ask a question about your customer feedback data.
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {SUGGESTED.map((s) => (
                <button
                  key={s}
                  onClick={() => onSend(s, deepResearch)}
                  disabled={isStreaming}
                  style={{
                    background: 'rgba(99,102,241,0.08)',
                    border: '1px solid rgba(99,102,241,0.2)',
                    color: '#818CF8',
                    borderRadius: '9999px',
                    padding: '6px 14px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    whiteSpace: 'normal',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(99,102,241,0.16)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(99,102,241,0.08)')}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            onPin={onPinChart}
            onPinChartEvent={onPinChartEvent}
            isPinned={pinnedIds.has(msg.id)}
            pinnedIds={pinnedIds}
            sessionId={sessionId}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="p-3" style={{ borderTop: '1px solid rgba(99,102,241,0.12)' }}>
        <div className="mb-2 flex items-center gap-2 min-h-[28px]">
          <button
            type="button"
            aria-pressed={deepResearch}
            disabled={isStreaming}
            onClick={() => setDeepResearch((enabled) => !enabled)}
            className="disabled:opacity-50"
            style={{
              background: deepResearch ? 'rgba(99,102,241,0.18)' : '#13131F',
              border: deepResearch ? '1px solid #6366F1' : '1px solid rgba(139,139,160,0.25)',
              borderRadius: '9999px',
              color: deepResearch ? '#818CF8' : '#8B8BA0',
              cursor: isStreaming ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              fontWeight: 500,
              padding: '5px 10px',
              transition: 'all 0.15s',
            }}
            title="Use deeper analysis for this question"
          >
            <Microscope size={13} />
            <span>Deep research</span>
            <span style={{ color: deepResearch ? '#22C55E' : '#8B8BA0' }}>
              {deepResearch ? 'On' : 'Off'}
            </span>
          </button>
          {deepResearch && (
            <span style={{ color: '#8B8BA0', fontSize: '11px' }}>~1–2 min, multiple charts</span>
          )}
        </div>
        <form onSubmit={handleSubmit} className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            className="resize-none focus:outline-none min-h-[40px] max-h-[120px]"
            style={{
              background: '#13131F',
              border: '1px solid rgba(99,102,241,0.15)',
              borderRadius: '12px',
              color: '#F8FAFC',
              fontSize: '13px',
              padding: '10px 14px',
              outline: 'none',
              flex: 1,
            }}
            placeholder="Ask about your data…"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(99,102,241,0.15)')}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="shrink-0"
              style={{ background: '#EF4444', color: 'white', border: 'none', borderRadius: '10px', padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              title="Stop"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="shrink-0 disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', color: 'white', border: 'none', borderRadius: '10px', padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              title="Send"
            >
              <Send size={16} />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function MultiChartCard({
  chartEvent,
  sessionId,
  onPin,
  isPinned,
}: {
  chartEvent: ChartEvent;
  sessionId: string;
  onPin: () => void;
  isPinned: boolean;
}) {
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineInput, setRefineInput] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [currentHtml, setCurrentHtml] = useState(chartEvent.html);
  const refineInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (refineOpen) refineInputRef.current?.focus();
  }, [refineOpen]);

  const handleRefine = async () => {
    const instruction = refineInput.trim();
    if (!instruction || isRefining) return;
    setIsRefining(true);
    try {
      const res = await fetch('/api/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          chart_html: currentHtml,
          refine_instruction: instruction,
          columns: chartEvent.columns ?? [],
        }),
      });
      const data = await res.json();
      if (data.chart_html && typeof data.chart_html === 'string') {
        setCurrentHtml(data.chart_html);
        setRefineInput('');
        setRefineOpen(false);
      }
    } catch {
      // ignore
    } finally {
      setIsRefining(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {isRefining ? (
        <div
          className="flex items-center justify-center h-[200px] rounded-lg"
          style={{ background: 'rgba(99,102,241,0.05)' }}
        >
          <div
            className="rounded-full px-3 py-2 flex items-center gap-1.5 text-xs"
            style={{ background: '#13131F', color: '#94A3B8' }}
          >
            <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
            <span className="ml-1" style={{ color: '#64748B' }}>Refining…</span>
          </div>
        </div>
      ) : (
        <ChartRenderer html={currentHtml} height={200} />
      )}
      {refineOpen && (
        <div className="flex items-center gap-1.5">
          <input
            ref={refineInputRef}
            type="text"
            value={refineInput}
            onChange={(e) => setRefineInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRefine(); if (e.key === 'Escape') setRefineOpen(false); }}
            placeholder="Refine this chart…"
            disabled={isRefining}
            className="disabled:opacity-50"
            style={{ background: '#1A1A2A', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '8px', color: '#F8FAFC', fontSize: '12px', padding: '6px 10px', outline: 'none', flex: 1 }}
          />
          <button onClick={handleRefine} disabled={!refineInput.trim() || isRefining}
            className="shrink-0 disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', color: 'white', border: 'none', borderRadius: '8px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px' }}>
            →
          </button>
        </div>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={() => setRefineOpen((v) => !v)}
          style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', color: '#818CF8', borderRadius: '6px', fontSize: '11px', padding: '3px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          ✏️ Refine
        </button>
        <button type="button" onClick={onPin}
          style={
            isPinned
              ? { background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.25)', color: '#22C55E', borderRadius: '6px', fontSize: '11px', padding: '3px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }
              : { background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', color: '#818CF8', borderRadius: '6px', fontSize: '11px', padding: '3px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }
          }>
          📌 {isPinned ? 'Pinned ✓' : 'Pin'}
        </button>
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  onPin,
  onPinChartEvent,
  isPinned,
  pinnedIds,
  sessionId,
}: {
  msg: Message;
  onPin: (msg: Message) => void;
  onPinChartEvent?: (msg: Message, event: ChartEvent, idx: number) => void;
  isPinned: boolean;
  pinnedIds: Set<string>;
  sessionId: string;
}) {
  const [sqlOpen, setSqlOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineInput, setRefineInput] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [refineError, setRefineError] = useState('');
  const [currentHtml, setCurrentHtml] = useState(msg.chart?.html);
  const refineInputRef = useRef<HTMLInputElement>(null);

  // Sync currentHtml when the chart SSE event arrives after mount
  useEffect(() => {
    if (msg.chart?.html && !currentHtml) {
      setCurrentHtml(msg.chart.html);
    }
  }, [msg.chart?.html, currentHtml]);

  useEffect(() => {
    if (refineOpen) refineInputRef.current?.focus();
  }, [refineOpen]);

  const handleRefine = async () => {
    const instruction = refineInput.trim();
    if (!instruction || isRefining || !currentHtml) return;
    setIsRefining(true);
    setRefineError('');
    try {
      const res = await fetch('/api/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          chart_html: currentHtml,
          refine_instruction: instruction,
          columns: msg.chart?.columns ?? [],
        }),
      });
      const data = await res.json();
      if (data.chart_html && typeof data.chart_html === 'string') {
        setCurrentHtml(data.chart_html);
        setRefineInput('');
        setRefineOpen(false);
      } else {
        setRefineError('Refinement returned an invalid chart. Original kept.');
      }
    } catch {
      setRefineError('Refinement failed. Please try again.');
    } finally {
      setIsRefining(false);
    }
  };

  const handleRefineKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRefine();
    }
    if (e.key === 'Escape') {
      setRefineOpen(false);
      setRefineInput('');
      setRefineError('');
    }
  };

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', color: 'white', borderRadius: '16px 16px 4px 16px', padding: '10px 14px', fontSize: '13px', maxWidth: '85%', marginLeft: 'auto', wordBreak: 'break-word' }}
        >
          {msg.content}
        </div>
      </div>
    );
  }

  const pinnedMsgRef = {
    ...msg,
    chart: msg.chart ? { ...msg.chart, html: currentHtml ?? msg.chart.html } : msg.chart,
  };
  const visibleCharts = (msg.charts ?? [])
    .map((chartEvent, idx) => ({ chartEvent, idx }))
    .filter((entry): entry is { chartEvent: ChartEvent; idx: number } => Boolean(entry.chartEvent));
  const missingChartCount = msg.announcedChartTotal
    ? msg.announcedChartTotal - visibleCharts.length
    : 0;

  return (
    <div className="flex flex-col gap-2">
      {/* Thinking indicator — indigo dots */}
      {msg.isLoading && (
        <div className="flex items-center gap-2">
          <div
            className="rounded-full px-3 py-2 flex items-center gap-1.5 text-xs"
            style={{ background: '#13131F', border: '1px solid rgba(99,102,241,0.15)', color: '#94A3B8' }}
          >
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
            {msg.thinking && <span className="ml-1" style={{ color: '#64748B' }}>{msg.thinking}</span>}
          </div>
        </div>
      )}

      {/* Genie narrative text — subtle assistant note above the chart */}
      {msg.genie_text && msg.genie_text.trim() && (
        <div
          className="overflow-y-auto"
          style={{ borderLeft: '2px solid #6366F1', marginBottom: '8px', color: '#94A3B8', fontSize: '13px', lineHeight: 1.6, background: 'rgba(99,102,241,0.05)', padding: '8px 12px', borderRadius: '0 6px 6px 0', maxHeight: '260px' }}
        >
          <div className="flex items-center gap-1" style={{ color: '#64748B', fontSize: '11px', fontWeight: 500, marginBottom: '5px' }}>
            <Sparkles size={11} />
            <span>Genie</span>
          </div>
          <MarkdownText text={msg.genie_text} />
        </div>
      )}

      {/* SQL badge */}
      {msg.sql && (
        <div className="text-xs">
          <button
            className="flex items-center gap-1 transition-colors"
            style={{ color: '#64748B' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#94A3B8')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#64748B')}
            onClick={() => setSqlOpen(!sqlOpen)}
          >
            <Database size={11} />
            <span
              style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '6px', fontFamily: 'monospace', fontSize: '11px', color: '#60A5FA', padding: '2px 8px' }}
            >
              SQL
            </span>
            {sqlOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
          {sqlOpen && (
            <pre
              className="mt-1 overflow-x-auto max-h-48"
              style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '6px', fontFamily: 'monospace', fontSize: '11px', color: '#60A5FA', padding: '6px 10px' }}
            >
              {msg.sql}
            </pre>
          )}
        </div>
      )}

      {/* Multi-chart grid */}
      {visibleCharts.length > 0 && (
        <>
          {!msg.isLoading && missingChartCount > 0 && (
            <p style={{ color: '#8B8BA0', fontSize: '11px', margin: 0 }}>
              Showing {visibleCharts.length} of {msg.announcedChartTotal} charts — {missingChartCount} did not load.
            </p>
          )}
          {!msg.isLoading && msg.chartOrderingWarning && (
            <p style={{ color: '#8B8BA0', fontSize: '11px', margin: 0 }}>{msg.chartOrderingWarning}</p>
          )}
          <div className="grid grid-cols-2 gap-2">
            {visibleCharts.map(({ chartEvent, idx }) => (
            <MultiChartCard
              key={idx}
              chartEvent={chartEvent}
              sessionId={sessionId}
              onPin={() => onPinChartEvent ? onPinChartEvent(msg, chartEvent, idx) : onPin({ ...msg, chart: chartEvent })}
              isPinned={pinnedIds.has(`${msg.id}:${idx}`)}
            />
            ))}
          </div>
        </>
      )}

      {/* Single Chart */}
      {msg.chart && (
        <div>
          {isRefining ? (
            <div
              className="flex items-center justify-center h-[260px] rounded-lg"
              style={{ background: 'rgba(99,102,241,0.05)' }}
            >
              <div
                className="rounded-full px-3 py-2 flex items-center gap-1.5 text-xs"
                style={{ background: '#13131F', border: '1px solid rgba(99,102,241,0.15)', color: '#94A3B8' }}
              >
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="ml-1" style={{ color: '#64748B' }}>Refining chart…</span>
              </div>
            </div>
          ) : (
            <ChartRenderer
              html={currentHtml ?? msg.chart.html}
              height={260}
            />
          )}

          {/* Refine input row */}
          {refineOpen && (
            <div className="mt-2 flex items-center gap-1.5">
              <input
                ref={refineInputRef}
                type="text"
                value={refineInput}
                onChange={(e) => setRefineInput(e.target.value)}
                onKeyDown={handleRefineKeyDown}
                placeholder="e.g. make it a line chart, sort descending…"
                disabled={isRefining}
                className="disabled:opacity-50"
                style={{ background: '#1A1A2A', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '8px', color: '#F8FAFC', fontSize: '12px', padding: '6px 10px', outline: 'none', flex: 1 }}
              />
              <button
                onClick={handleRefine}
                disabled={!refineInput.trim() || isRefining}
                className="shrink-0 disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', color: 'white', border: 'none', borderRadius: '8px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px' }}
                title="Apply refinement"
              >
                →
              </button>
            </div>
          )}

          {refineError && (
            <p className="mt-1 text-xs" style={{ color: '#EF4444' }}>{refineError}</p>
          )}

          <div className="mt-2 flex items-center justify-end gap-2 relative" style={{ zIndex: 20, pointerEvents: 'auto' }}>
            <button
              type="button"
              onClick={() => { setRefineOpen((v) => !v); setRefineError(''); }}
              style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', color: '#818CF8', borderRadius: '6px', fontSize: '11px', padding: '3px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              title="Refine this chart"
            >
              ✏️ Refine
            </button>
            <button
              type="button"
              onClick={() => onPin(pinnedMsgRef as Message)}
              style={
                isPinned
                  ? { background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.25)', color: '#22C55E', borderRadius: '6px', fontSize: '11px', padding: '3px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }
                  : { background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', color: '#818CF8', borderRadius: '6px', fontSize: '11px', padding: '3px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }
              }
              title="Pin this chart"
            >
              📌 {isPinned ? 'Pinned' : 'Pin this chart'}
            </button>
          </div>
        </div>
      )}

      {/* Text answer — suppress generic filler when a chart is present */}
      {msg.content && !msg.isLoading && !msg.chart && !(msg.charts && msg.charts.length > 0) && (
        <div
          style={{ background: '#13131F', border: '1px solid rgba(99,102,241,0.15)', borderRadius: '4px 16px 16px 16px', padding: '10px 14px', fontSize: '13px', color: '#F8FAFC', maxWidth: '95%' }}
        >
          {msg.content}
        </div>
      )}
    </div>
  );
}
