import { useState, useCallback, useRef } from 'react';

export type ChartEvent = {
  type: 'chart';
  html: string;
  sql: string;
  columns?: { name: string; type: string }[];
  chart_index?: number;
  chart_total?: number;
  index?: number;
  total?: number;
  title?: string;
};

export type SSEEvent =
  | { type: 'thinking'; text: string }
  | { type: 'genie_text'; text: string; index?: number }
  | { type: 'sql'; sql: string }
  | { type: 'rows'; columns: { name: string; type: string }[]; rows: unknown[][] }
  | ChartEvent
  | { type: 'done' }
  | { type: 'rejected'; reason: string }
  | { type: 'error'; message: string };

type AskAboutVizEvent =
  | { type: 'insight_delta'; text: string }
  | { type: 'insight'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type AskAboutVizPayload = {
  title: string;
  chartHtml: string;
  sql?: string | null;
  question: string;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  genie_text?: string;
  sql?: string;
  chart?: ChartEvent;
  charts?: (ChartEvent | undefined)[];
  announcedChartTotal?: number;
  chartOrderingWarning?: string;
  columns?: { name: string; type: string }[];
  rows?: unknown[][];
  isLoading?: boolean;
};

export function useGenieChat(sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (question: string, deepResearch = false) => {
      if (isStreaming) return;

      const userMsg: Message = {
        id: `u-${Date.now()}`,
        role: 'user',
        content: question,
      };

      const assistantId = `a-${Date.now()}`;
      const assistantMsg: Message = {
        id: assistantId,
        role: 'assistant',
        content: '',
        isLoading: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      abortRef.current = new AbortController();

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            session_id: sessionId,
            deep_research: deepResearch,
          }),
          signal: abortRef.current.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;

            try {
              const event: SSEEvent = JSON.parse(raw);
              handleSSEEvent(event, assistantId, setMessages);
            } catch {
              // ignore parse errors
            }
          }
        }
      } catch (err: unknown) {
        if ((err as Error).name !== 'AbortError') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: `Error: ${(err as Error).message}`,
                    isLoading: false,
                  }
                : m,
            ),
          );
        }
      } finally {
        setIsStreaming(false);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, isLoading: false } : m)),
        );
      }
    },
    [isStreaming, sessionId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const askAboutViz = useCallback(async ({ title, chartHtml, sql, question }: AskAboutVizPayload) => {
    if (isStreaming) return;
    const trimmedQuestion = question.trim().slice(0, 2000);
    if (!trimmedQuestion) return;

    const now = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userMsg: Message = { id: `u-viz-${now}`, role: 'user', content: `About “${title}”: ${trimmedQuestion}` };
    const assistantId = `a-viz-${now}`;
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', isLoading: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    if (!sql?.trim()) {
      setMessages((prev) => prev.map((m) => m.id === assistantId
        ? { ...m, content: 'I can’t answer questions about this visualisation because its source SQL was not saved. Recreate and pin the chart with SQL, then try again.', isLoading: false }
        : m));
      return;
    }

    setIsStreaming(true);
    abortRef.current = new AbortController();
    try {
      const response = await fetch('/api/ask_about_viz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chart_html: chartHtml.slice(0, 100000),
          sql: sql.trim().slice(0, 10000),
          question: trimmedQuestion,
          session_id: sessionId,
        }),
        signal: abortRef.current.signal,
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try { const body = await response.json(); detail = body.detail || detail; } catch { /* non-JSON error */ }
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      }
      if (!response.body) throw new Error('The response stream was empty.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6).trim()) as AskAboutVizEvent;
            if (event.type === 'insight_delta') {
              setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: m.content + event.text } : m));
            } else if (event.type === 'insight') {
              // Terminal text is cleaned and authoritative: replace raw deltas.
              setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: event.text } : m));
            } else if (event.type === 'error') {
              throw new Error(event.message || 'The agent returned an error.');
            }
            // Unknown additive event types are intentionally ignored.
          } catch (err) {
            if (err instanceof SyntaxError) continue;
            throw err;
          }
        }
        if (done) break;
      }
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? { ...m, content: `I couldn’t answer that visualisation question: ${(err as Error).message}`, isLoading: false }
          : m));
      }
    } finally {
      setIsStreaming(false);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, isLoading: false } : m));
    }
  }, [isStreaming, sessionId]);

  return { messages, isStreaming, sendMessage, askAboutViz, stop };
}

function handleSSEEvent(
  event: SSEEvent,
  assistantId: string,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
) {
  setMessages((prev) =>
    prev.map((m) => {
      if (m.id !== assistantId) return m;

      switch (event.type) {
        case 'thinking':
          return { ...m, thinking: event.text };

        case 'genie_text':
          // nurix-agent narrative — accumulate as a subtle assistant note above the chart.
          // Join on a blank line so each event stays its own markdown block; a space
          // would glue a list item onto the previous paragraph and lose the structure.
          return { ...m, genie_text: (m.genie_text ? m.genie_text + '\n\n' : '') + event.text };

        case 'sql':
          return { ...m, sql: event.sql };

        case 'rows':
          return { ...m, columns: event.columns, rows: event.rows };

        case 'chart': {
          const chartIndex = event.chart_index ?? event.index;
          const chartTotal = event.chart_total ?? event.total;
          const isMulti = typeof chartTotal === 'number' && chartTotal > 1;
          if (isMulti) {
            const charts = [...(m.charts ?? [])];
            let chartOrderingWarning = m.chartOrderingWarning;
            if (chartIndex === undefined || charts[chartIndex]) {
              charts.push(event);
              chartOrderingWarning = 'Some charts arrived without a unique position; all available charts are shown.';
            } else {
              charts[chartIndex] = event;
            }
            return {
              ...m,
              charts,
              announcedChartTotal: chartTotal,
              chartOrderingWarning,
              content: m.content || '',
              thinking: undefined,
            };
          }
          return {
            ...m,
            chart: event,
            content: m.content || '',
            thinking: undefined,
          };
        }

        case 'done':
          return { ...m, isLoading: false, thinking: undefined };

        case 'rejected':
          return {
            ...m,
            content: event.reason || 'Not relevant to feedback data',
            isLoading: false,
            thinking: undefined,
          };

        case 'error':
          return {
            ...m,
            content: `Something went wrong: ${event.message}`,
            isLoading: false,
            thinking: undefined,
          };

        default:
          return m;
      }
    }),
  );
}
