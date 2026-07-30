import { useEffect, useRef, useState } from 'react';
import { Send, Square, Database, ChevronDown, ChevronUp } from 'lucide-react';
import type { Message } from '../hooks/useGenieChat';
import { ChartRenderer } from './ChartRenderer';

const SUGGESTED = [
  'What are the top feature areas by number of negative reviews?',
  'Show me sentiment trends over time for Pro users',
  'Which country has the highest average urgency score?',
];

interface ChatPanelProps {
  messages: Message[];
  isStreaming: boolean;
  onSend: (q: string) => void;
  onStop: () => void;
  onPinChart: (msg: Message) => void;
  pinnedIds: Set<string>;
  sessionId: string;
}

export function ChatPanel({
  messages,
  isStreaming,
  onSend,
  onStop,
  onPinChart,
  pinnedIds,
  sessionId,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
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
    onSend(q);
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
            <p className="text-sm text-muted-foreground mb-4">
              Ask a question about your customer feedback data.
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {SUGGESTED.map((s) => (
                <button
                  key={s}
                  className="text-xs px-3 py-2 rounded-full border hover:bg-accent hover:border-primary transition-colors"
                  onClick={() => onSend(s)}
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
            isPinned={pinnedIds.has(msg.id)}
            sessionId={sessionId}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="border-t p-3">
        <form onSubmit={handleSubmit} className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px]"
            placeholder="Ask about your data…"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="h-10 w-10 flex items-center justify-center rounded-lg bg-destructive text-white hover:bg-destructive/90 shrink-0"
              title="Stop"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="h-10 w-10 flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 shrink-0"
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

function MessageBubble({
  msg,
  onPin,
  isPinned,
  sessionId,
}: {
  msg: Message;
  onPin: (msg: Message) => void;
  isPinned: boolean;
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
        <div className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2 text-sm shadow-sm">
          {msg.content}
        </div>
      </div>
    );
  }

  const pinnedMsgRef = {
    ...msg,
    chart: msg.chart ? { ...msg.chart, html: currentHtml ?? msg.chart.html } : msg.chart,
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Thinking indicator */}
      {msg.isLoading && (
        <div className="flex items-center gap-2">
          <div className="bg-muted rounded-full px-3 py-2 flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
            {msg.thinking && <span className="ml-1">{msg.thinking}</span>}
          </div>
        </div>
      )}

      {/* SQL badge */}
      {msg.sql && (
        <div className="text-xs">
          <button
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => setSqlOpen(!sqlOpen)}
          >
            <Database size={11} />
            <span className="bg-muted/60 rounded-md px-2 py-1 font-mono text-[11px]">SQL</span>
            {sqlOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
          {sqlOpen && (
            <pre className="mt-1 bg-muted p-2 rounded text-xs overflow-x-auto max-h-48">
              {msg.sql}
            </pre>
          )}
        </div>
      )}

      {/* Chart */}
      {msg.chart && (
        <div>
          {isRefining ? (
            <div className="flex items-center justify-center h-[260px] bg-muted/20 rounded-lg">
              <div className="bg-muted rounded-full px-3 py-2 flex items-center gap-1.5 text-muted-foreground text-xs">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="ml-1">Refining chart…</span>
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
                className="flex-1 text-xs rounded-lg border border-input bg-background px-3 py-1.5 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
              <button
                onClick={handleRefine}
                disabled={!refineInput.trim() || isRefining}
                className="h-7 w-7 flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 shrink-0 text-xs"
                title="Apply refinement"
              >
                →
              </button>
            </div>
          )}

          {refineError && (
            <p className="mt-1 text-xs text-destructive">{refineError}</p>
          )}

          <div className="mt-2 flex items-center justify-end gap-2 relative" style={{ zIndex: 20, pointerEvents: 'auto' }}>
            <button
              type="button"
              onClick={() => { setRefineOpen((v) => !v); setRefineError(''); }}
              className="text-xs px-3 py-1.5 rounded-full border font-medium flex items-center gap-1 transition-colors bg-muted/40 hover:bg-muted text-muted-foreground border-border"
              title="Refine this chart"
            >
              ✏️ Refine
            </button>
            <button
              type="button"
              onClick={() => onPin(pinnedMsgRef as Message)}
              className={`text-xs px-3 py-1.5 rounded-full border font-medium flex items-center gap-1 transition-colors ${
                isPinned
                  ? 'bg-green-50 text-green-700 border-green-200'
                  : 'bg-primary/10 hover:bg-primary/20 text-primary border-primary/20'
              }`}
              title="Pin this chart"
            >
              📌 {isPinned ? 'Pinned' : 'Pin this chart'}
            </button>
          </div>
        </div>
      )}

      {/* Text answer */}
      {msg.content && !msg.isLoading && (
        <div className="text-sm text-foreground bg-muted/40 rounded-2xl rounded-tl-sm px-4 py-2 max-w-[90%]">
          {msg.content}
        </div>
      )}
    </div>
  );
}
