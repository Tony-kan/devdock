"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import { formatTime } from "@/components/ui";
import type { LogEntry, LogLevel } from "@/lib/types";

const LEVEL_TEXT: Record<LogLevel, string> = {
  info: "text-log-ink",
  warn: "text-amber-200",
  error: "text-red-300",
};

const LEVEL_TAG: Record<LogLevel, string> = {
  info: "text-sky-300/80",
  warn: "text-amber-300",
  error: "text-red-400",
};

/** Stable per-service hue so the combined stream stays readable. */
const SERVICE_COLOURS = [
  "text-emerald-300",
  "text-sky-300",
  "text-violet-300",
  "text-amber-300",
  "text-rose-300",
  "text-teal-300",
  "text-indigo-300",
  "text-lime-300",
];

function serviceColour(service: string): string {
  let hash = 0;
  for (let i = 0; i < service.length; i += 1) hash = (hash * 31 + service.charCodeAt(i)) % 997;
  return SERVICE_COLOURS[hash % SERVICE_COLOURS.length];
}

/**
 * Absolute http(s) URLs, plus the bare `localhost:3000` / `127.0.0.1:8080` forms that
 * dev servers and Spring print constantly. Only these two shapes are ever turned into
 * anchors, so a log line can never inject a `javascript:` or `data:` href.
 */
const LINK_PATTERN = new RegExp(
  ["https?://[^\\s<>\"'`]+", "(?:localhost|127\\.0\\.0\\.1):\\d{2,5}(?:/[^\\s<>\"'`]*)?"].join("|"),
  "gi",
);

/** Punctuation that almost always belongs to the sentence, not the URL. */
const TRAILING_NOISE = /[.,;:!?"'`]+$/;

interface Segment {
  text: string;
  href: string | null;
}

export function linkify(line: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const match of line.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    let found = match[0];

    // Trim trailing punctuation, and an unbalanced closing bracket, back into the text.
    found = found.replace(TRAILING_NOISE, "");
    while (/[)\]}]$/.test(found)) {
      const open = found[found.length - 1] === ")" ? "(" : found[found.length - 1] === "]" ? "[" : "{";
      const closes = found.split(found[found.length - 1]).length - 1;
      const opens = found.split(open).length - 1;
      if (opens >= closes) break;
      found = found.slice(0, -1);
    }
    if (!found) continue;

    if (start > cursor) segments.push({ text: line.slice(cursor, start), href: null });
    segments.push({ text: found, href: /^https?:\/\//i.test(found) ? found : `http://${found}` });
    cursor = start + found.length;
  }

  if (cursor < line.length) segments.push({ text: line.slice(cursor), href: null });
  return segments;
}

const linkClass =
  "rounded px-0.5 text-sky-300 underline decoration-sky-300/40 decoration-dotted underline-offset-2 " +
  "transition-colors hover:bg-sky-400/15 hover:text-sky-200 hover:decoration-sky-200 hover:decoration-solid " +
  "focus-visible:bg-sky-400/20 focus-visible:text-sky-100 focus-visible:outline-none";

function Message({ text, className }: { text: string; className: string }) {
  const segments = useMemo(() => linkify(text), [text]);

  if (segments.length === 1 && segments[0].href === null) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.href ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${segment.href} in a new tab`}
            className={linkClass}
          >
            {segment.text}
          </a>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

/**
 * Memoised per line. Entries are immutable and keyed by `seq`, so the thousands of
 * lines already on screen do not re-render when a state tick or a new line arrives.
 */
const Line = memo(function Line({ entry, showService }: { entry: LogEntry; showService: boolean }) {
  return (
    <li className="flex gap-2 border-b border-log-line/40 py-px last:border-b-0">
      <span className="shrink-0 text-slate-500 tabular-nums">{formatTime(entry.ts)}</span>
      {showService ? (
        <>
          <span className="shrink-0 text-slate-600">·</span>
          <span className={`w-[13ch] shrink-0 truncate ${serviceColour(entry.service)}`} title={entry.service}>
            {entry.service}
          </span>
        </>
      ) : null}
      <span className="shrink-0 text-slate-600">·</span>
      <span className={`w-[5ch] shrink-0 uppercase ${LEVEL_TAG[entry.level]}`}>{entry.level}</span>
      <span className="shrink-0 text-slate-600">·</span>
      <Message text={entry.text} className={`min-w-0 flex-1 wrap-break-word whitespace-pre-wrap ${LEVEL_TEXT[entry.level]}`} />
    </li>
  );
});

export function LogPane({
  entries,
  follow,
  showService,
  emptyHint,
}: {
  entries: LogEntry[];
  follow: boolean;
  showService: boolean;
  emptyHint: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : 0;

  useEffect(() => {
    if (!follow) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [follow, lastSeq, entries.length]);

  return (
    <div
      ref={scroller}
      className="scroll-slim-dark min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-log-bg px-3 py-2 font-mono text-[12px] leading-[1.55]"
      role="log"
      aria-live="off"
      aria-label="Service output"
    >
      {entries.length === 0 ? (
        <p className="px-1 py-6 text-slate-500">{emptyHint}</p>
      ) : (
        <ol>
          {entries.map((entry) => (
            <Line key={entry.seq} entry={entry} showService={showService} />
          ))}
        </ol>
      )}
    </div>
  );
}
