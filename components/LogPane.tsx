"use client";

import { useEffect, useRef } from "react";
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
            <li key={entry.seq} className="flex gap-2 border-b border-log-line/40 py-[1px] last:border-b-0">
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
              <span className={`min-w-0 flex-1 break-words whitespace-pre-wrap ${LEVEL_TEXT[entry.level]}`}>
                {entry.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
