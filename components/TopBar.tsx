"use client";

import { Button } from "@/components/ui";
import type { GitInfo, Snapshot } from "@/lib/types";

interface Props {
  snapshot: Snapshot;
  /** Git info for the selected service's repo, or null on the combined view. */
  focusedGit: GitInfo | null;
  busy: string | null;
  onPullAll: () => void;
  onStartAll: () => void;
  onStopAll: () => void;
}

function GitSummary({ snapshot, focusedGit }: { snapshot: Snapshot; focusedGit: GitInfo | null }) {
  // The workspace holds many independent repositories, so there is no single branch
  // to show. With a service selected we show its repo; otherwise a roll-up.
  if (focusedGit?.isRepo) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-top-ink/70">
        <span className="truncate text-top-ink/50">{focusedGit.repo}</span>
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-top-ink">{focusedGit.branch ?? "detached"}</span>
        {focusedGit.upstream ? null : <span className="text-warn">no upstream</span>}
        {focusedGit.ahead > 0 ? <span className="text-sky-300">↑{focusedGit.ahead}</span> : null}
        {focusedGit.behind > 0 ? <span className="text-warn">↓{focusedGit.behind}</span> : null}
        {focusedGit.dirty > 0 ? (
          <span className="text-warn">{focusedGit.dirty} dirty</span>
        ) : (
          <span className="text-ok">clean</span>
        )}
        {focusedGit.error ? <span className="text-bad">{focusedGit.error}</span> : null}
      </div>
    );
  }

  const { repos, dirtyRepos, behindRepos } = snapshot.counts;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-top-ink/70">
      <span className="rounded bg-white/10 px-1.5 py-0.5 text-top-ink">{repos} repos</span>
      <span className={dirtyRepos > 0 ? "text-warn" : "text-ok"}>{dirtyRepos} dirty</span>
      <span className={behindRepos > 0 ? "text-warn" : "text-top-ink/50"}>{behindRepos} behind</span>
    </div>
  );
}

export function TopBar({ snapshot, focusedGit, busy, onPullAll, onStartAll, onStopAll }: Props) {
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-gradient-to-r from-top to-top-soft px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tracking-tight text-white">Devdock</span>
        <span className="text-xs text-top-ink/50">services console</span>
      </div>

      <GitSummary snapshot={snapshot} focusedGit={focusedGit} />

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onPullAll}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-sm font-medium text-top-ink ring-1 ring-inset ring-white/15 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy === "pull-all" ? "Pulling…" : "Pull latest"}
        </button>
        <Button tone="primary" onClick={onStartAll} disabled={busy !== null}>
          {busy === "start-all" ? "Starting…" : "Start all"}
        </Button>
        <button
          type="button"
          onClick={onStopAll}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-sm font-medium text-top-ink ring-1 ring-inset ring-white/15 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy === "stop-all" ? "Stopping…" : "Stop all"}
        </button>
      </div>
    </header>
  );
}
