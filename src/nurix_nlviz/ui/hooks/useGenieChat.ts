import { useState, useCallback, useRef } from 'react';

export type ChartEvent = {
  type: 'chart';
  html: string;
  sql: string;
  columns?: { name: string; type: string }[];
};

export type SSEEvent =
  | { type: 'thinking'; text: string }
  | { type: 'sql'; sql: string }
  | { type: 'rows'; columns: { name: string; type: string }[]; rows: unknown[][] }
  | ChartEvent
  | { type: 'done' }
  | { type: 'error'; message: string };

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  sql?: string;
  chart?: ChartEvent;
  columns?: { name: string; type: string }[];
  rows?: unknown[][];
  isLoading?: boolean;
};

export function useGenieChat(sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (question: string) => {
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
          body: JSON.stringify({ question, session_id: sessionId }),
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

  return { messages, isStreaming, sendMessage, stop };
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

        case 'sql':
          return { ...m, sql: event.sql };

        case 'rows':
          return { ...m, columns: event.columns, rows: event.rows };

        case 'chart':
          return {
            ...m,
            chart: event,
            content: m.content || 'Here is the visualization:',
            thinking: undefined,
          };

        case 'done':
          return { ...m, isLoading: false, thinking: undefined };

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
