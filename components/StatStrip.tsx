"use client";

import { formatClock } from "@/components/ui";
import type { Snapshot } from "@/lib/types";

function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs text-ink-faint">{label}</span>
      <span className={`font-mono text-sm ${tone || "text-ink"}`}>{value}</span>
    </div>
  );
}

export function StatStrip({ snapshot, connected }: { snapshot: Snapshot; connected: boolean }) {
  const { running, total, errors } = snapshot.counts;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-panel px-4 py-2">
      <Stat label="Running" value={`${running} / ${total}`} tone={running > 0 ? "text-ok" : "text-ink-soft"} />
      <Stat label="Errors" value={String(errors)} tone={errors > 0 ? "text-bad" : "text-ink-soft"} />
      <Stat label="Last pull" value={formatClock(snapshot.lastPullAt)} tone="text-ink-soft" />
      <Stat label="Workspace" value={snapshot.root} tone="text-ink-soft" />
      <div className="ml-auto flex items-center gap-1.5">
        <span className={`inline-block size-2 rounded-full ${connected ? "bg-ok" : "bg-bad"}`} aria-hidden />
        <span className="text-xs text-ink-faint">{connected ? "live" : "reconnecting…"}</span>
      </div>
    </div>
  );
}
