import { useMemo } from 'react';

/**
 * Dependency-free renderer for the tiny markdown subset Genie emits in its
 * narrative: **bold**, `code`, `- ` bullets and blank-line paragraphs.
 *
 * Everything is produced as React elements — no dangerouslySetInnerHTML — so
 * LLM output over customer data can never escape into markup.
 */

type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string };

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] };

// ── Parsing ────────────────────────────────────────────────────────────────

/** " - " used as an inline bullet separator. Spaces are required, so "5-second" is safe. */
const INLINE_SEP = /\s-\s+/g;
/** A line-leading bullet: "- item" or "* item". "**bold**" does not match (no space after *). */
const BULLET_LINE = /^[ \t]*[-*][ \t]+(.*)$/;
/**
 * A bold span. Like CommonMark, the delimiters may not hug whitespace, so a
 * stray "** " in the middle of a sentence stays literal instead of swallowing
 * the rest of the text up to the next marker.
 */
const BOLD = /\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/;
/** Bold segment plus any parentheticals that immediately follow it — one Genie list item. */
const ITEM_HEAD = new RegExp(`^(${BOLD.source}(?:[ \\t]*\\([^)]*\\))*)[ \\t]*([\\s\\S]*)$`);

function separatorPositions(text: string): Array<[number, number]> {
  const re = new RegExp(INLINE_SEP.source, 'g');
  const out: Array<[number, number]> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function startsWithBold(text: string): boolean {
  return new RegExp('^' + BOLD.source).test(text.trim());
}

/**
 * Genie runs its list items together on one line, and the paragraph that follows
 * the list gets glued onto the last item. An item is "**bold** (parenthetical)";
 * anything after that which opens like a new sentence is the next paragraph.
 */
function splitTrailingProse(raw: string): { item: string; rest: string } {
  const m = ITEM_HEAD.exec(raw);
  if (!m) return { item: raw, rest: '' };
  const rest = m[3].trim();
  // A lowercase continuation ("**Export** is slow") is still part of the item.
  if (!rest || !/^(\*\*|[A-Z])/.test(rest)) return { item: raw, rest: '' };
  return { item: m[1].trim(), rest };
}

/** Split a run that starts with item text (no leading separator) into list items. */
function splitRun(run: string): { items: string[]; tail: string } {
  const positions = separatorPositions(run);
  const items: string[] = [];
  let cursor = 0;

  for (let i = 0; i <= positions.length; i++) {
    const end = i < positions.length ? positions[i][0] : run.length;
    const raw = run.slice(cursor, end).trim();
    cursor = i < positions.length ? positions[i][1] : run.length;
    if (!raw) continue;

    const { item, rest } = splitTrailingProse(raw);
    items.push(item);
    if (rest) {
      // Everything from here on is prose again — hand it back for re-parsing.
      return { items, tail: (rest + run.slice(end)).trim() };
    }
  }

  return { items, tail: '' };
}

/**
 * Find an inline bullet run inside a paragraph. Only treated as a list when the
 * text before it ends with ":" or the first item is bolded — both are how Genie
 * introduces a list, and both keep prose like "scores 4 - 5" out of the parser.
 */
function findInlineList(text: string): { head: string; items: string[]; tail: string } | null {
  const positions = separatorPositions(text);
  if (positions.length === 0) return null;

  const head = text.slice(0, positions[0][0]).trim();
  const run = text.slice(positions[0][1]);
  if (!head.endsWith(':') && !startsWithBold(run)) return null;

  const { items, tail } = splitRun(run);
  if (items.length === 0) return null;
  return { head, items, tail };
}

/** A paragraph may hide a list run (and a paragraph after it, and another list…). */
function paragraphToBlocks(text: string): Block[] {
  const out: Block[] = [];
  let remaining = text.trim();

  for (let guard = 0; remaining && guard < 50; guard++) {
    const found = findInlineList(remaining);
    if (!found) {
      out.push({ kind: 'p', text: remaining });
      return out;
    }
    if (found.head) out.push({ kind: 'p', text: found.head });
    out.push({ kind: 'ul', items: found.items });
    remaining = found.tail;
  }

  if (remaining) out.push({ kind: 'p', text: remaining });
  return out;
}

export function parseMarkdown(input: string): Block[] {
  if (typeof input !== 'string') return [];
  const text = input.replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];

  const blocks: Block[] = [];

  for (const chunk of text.split(/\n[ \t]*\n+/)) {
    if (!chunk.trim()) continue;

    let paraLines: string[] = [];
    let items: string[] = [];

    const flushPara = () => {
      if (paraLines.length === 0) return;
      blocks.push(...paragraphToBlocks(paraLines.join(' ')));
      paraLines = [];
    };
    const flushList = () => {
      if (items.length === 0) return;
      blocks.push({ kind: 'ul', items });
      items = [];
    };

    for (const line of chunk.split('\n')) {
      const bullet = BULLET_LINE.exec(line);
      if (bullet) {
        flushPara();
        const content = bullet[1].trim();
        if (!content) continue;
        // A bullet line can itself carry a run of further inline items.
        if (/\s-\s+\*\*/.test(content)) {
          const { items: expanded, tail } = splitRun(content);
          items.push(...expanded);
          if (tail) {
            flushList();
            blocks.push(...paragraphToBlocks(tail));
          }
        } else {
          items.push(content);
        }
        continue;
      }
      if (!line.trim()) continue;
      flushList();
      paraLines.push(line.trim());
    }

    flushList();
    flushPara();
  }

  return blocks;
}

/** Split a string into text / **bold** / `code` runs. Unmatched ** stays literal. */
export function parseInline(text: string): Inline[] {
  const re = new RegExp('`([^`]+)`|' + BOLD.source, 'g');
  const out: Inline[] = [];
  let last = 0;

  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else out.push({ kind: 'strong', text: m[2] });
    last = m.index + m[0].length;
  }

  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

// ── Rendering ──────────────────────────────────────────────────────────────

const blockStyle: React.CSSProperties = { margin: 0 };
const spacedStyle: React.CSSProperties = { margin: '6px 0 0' };
const ulStyle: React.CSSProperties = {
  paddingLeft: '18px',
  listStyleType: 'disc',
  listStylePosition: 'outside',
};
const liStyle: React.CSSProperties = { marginBottom: '3px' };
const strongStyle: React.CSSProperties = { color: '#E2E8F0', fontWeight: 600 };
const codeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.92em',
  background: 'rgba(8,145,178,0.12)',
  border: '1px solid rgba(8,145,178,0.2)',
  borderRadius: '4px',
  color: '#22D3EE',
  padding: '1px 4px',
};

function Inlines({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((run, i) => {
        if (run.kind === 'strong') return <strong key={i} style={strongStyle}>{run.text}</strong>;
        if (run.kind === 'code') return <code key={i} style={codeStyle}>{run.text}</code>;
        return <span key={i}>{run.text}</span>;
      })}
    </>
  );
}

export function MarkdownText({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return null;

  return (
    <>
      {blocks.map((block, i) => {
        const spacing = i === 0 ? blockStyle : spacedStyle;
        if (block.kind === 'ul') {
          return (
            <ul key={i} style={{ ...spacing, ...ulStyle }}>
              {block.items.map((item, j) => (
                <li key={j} style={liStyle}>
                  <Inlines text={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} style={spacing}>
            <Inlines text={block.text} />
          </p>
        );
      })}
    </>
  );
}
