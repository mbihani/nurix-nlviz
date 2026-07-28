import { useEffect, useRef, useState } from 'react';
import { Send, Square, Loader2, Database, ChevronDown, ChevronUp } from 'lucide-react';
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
}

export function ChatPanel({
  messages,
  isStreaming,
  onSend,
  onStop,
  onPinChart,
  pinnedIds,
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
            <div className="flex flex-col gap-2">
              {SUGGESTED.map((s) => (
                <button
                  key={s}
                  className="text-xs text-left px-3 py-2 rounded-lg border border-dashed hover:bg-accent hover:border-primary transition-colors"
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
}: {
  msg: Message;
  onPin: (msg: Message) => void;
  isPinned: boolean;
}) {
  const [sqlOpen, setSqlOpen] = useState(false);

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2 text-sm">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Thinking indicator */}
      {msg.isLoading && msg.thinking && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          <span>{msg.thinking}</span>
        </div>
      )}
      {msg.isLoading && !msg.thinking && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          <span>Thinking…</span>
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
            <span>SQL</span>
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
        <div className="rounded-xl border bg-card p-3">
          <ChartRenderer
            chartType={msg.chart.chartType}
            config={msg.chart.config}
            data={msg.chart.data}
            height={260}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground capitalize">
              {msg.chart.chartType} chart · {msg.chart.data.length} rows
            </span>
            <button
              onClick={() => onPin(msg)}
              disabled={isPinned}
              className="text-xs px-2 py-1 rounded border hover:bg-accent disabled:opacity-40 flex items-center gap-1"
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
