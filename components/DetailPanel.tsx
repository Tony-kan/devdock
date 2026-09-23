"use client";

import { Button, KindChip, StatusPill, formatUptime } from "@/components/ui";
import { LogPane } from "@/components/LogPane";
import { ServiceEditor } from "@/components/ServiceEditor";
import { ConflictPanel } from "@/components/ConflictPanel";
import {
  ALL_SERVICES,
  type ConflictResolution,
  type GitInfo,
  type LogEntry,
  type LogLevel,
  type PortConflict,
  type ServiceConfig,
  type Snapshot,
} from "@/lib/types";

export type LevelFilter = "all" | LogLevel;

const LEVEL_FILTERS: LevelFilter[] = ["all", "info", "warn", "error"];

const PILL_ACTIVE: Record<LevelFilter, string> = {
  all: "bg-accent text-white",
  info: "bg-accent text-white",
  warn: "bg-warn text-white",
  error: "bg-bad text-white",
};

interface Props {
  snapshot: Snapshot;
  service: ServiceConfig | null;
  git: GitInfo | null;
  entries: LogEntry[];
  totalEntries: number;
  levelCounts: Record<LogLevel, number>;
  level: LevelFilter;
  onLevel: (level: LevelFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  follow: boolean;
  onFollow: (follow: boolean) => void;
  onClear: () => void;
  onCopy: () => void;
  onAction: (action: "start" | "stop" | "restart" | "pull" | "install") => void;
  onOpen: () => void;
  editing: boolean;
  onEditing: (editing: boolean) => void;
  onSave: (patch: Partial<ServiceConfig> & { env: Record<string, string> }) => Promise<void>;
  onRemove: () => Promise<void>;
  busy: string | null;
  notice: { level: LogLevel; message: string } | null;
  onDismissNotice: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  conflict: PortConflict | null;
  onResolveConflict: (resolution: ConflictResolution, options: { port?: number; persist?: boolean }) => void;
  onDismissConflict: () => void;
}

function CombinedHeader({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="text-base font-semibold text-ink">All services</h1>
      <span className="text-xs text-ink-soft">combined output from every configured service</span>
      <span className="font-mono text-xs text-ink-faint">
        {snapshot.counts.running} running · {snapshot.counts.total} configured
      </span>
    </div>
  );
}

function ServiceHeader({
  service,
  snapshot,
  git,
}: {
  service: ServiceConfig;
  snapshot: Snapshot;
  git: GitInfo | null;
}) {
  const runtime = snapshot.runtime[service.id];
  const shared = snapshot.sharedPorts[service.id] ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h1 className="text-base font-semibold text-ink">{service.name}</h1>
        <StatusPill status={runtime?.status ?? "stopped"} exitCode={runtime?.exitCode ?? null} />
        <KindChip kind={service.kind} />
        {service.port || service.url ? (
          <a
            href={service.url ?? `http://localhost:${service.port}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${service.url ?? `http://localhost:${service.port}`} in a new tab`}
            className="rounded px-0.5 font-mono text-xs text-accent underline decoration-accent/40 decoration-dotted underline-offset-2 transition-colors hover:bg-accent-soft hover:decoration-accent hover:decoration-solid"
          >
            {service.port ? `:${service.port}` : service.url}
          </a>
        ) : null}
        {runtime?.activePort && runtime.activePort !== service.port ? (
          <a
            href={`http://localhost:${runtime.activePort}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Running on port ${runtime.activePort} instead of the configured ${service.port ?? "none"}`}
            className="rounded bg-warn/15 px-1 font-mono text-xs text-amber-700 ring-1 ring-warn/30 ring-inset hover:bg-warn/25"
          >
            running on :{runtime.activePort}
          </a>
        ) : null}
        {runtime?.adopted ? (
          <span
            className="rounded bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-sky-200 ring-inset"
            title="Started outside this console. It can be stopped and restarted here, but output from before it was picked up went to wherever it was started."
          >
            adopted
          </span>
        ) : null}
        {runtime?.status === "running" ? (
          <span className="font-mono text-xs text-ink-faint">
            pid {runtime.pid} · up {formatUptime(runtime.uptimeMs)}
          </span>
        ) : null}
        {runtime && runtime.restarts > 0 ? (
          <span className="font-mono text-xs text-ink-faint">{runtime.restarts} restarts</span>
        ) : null}
        {runtime?.health === "fail" ? <span className="text-xs font-medium text-bad">health check failing</span> : null}
        {runtime?.health === "pass" ? <span className="text-xs text-ok">healthy</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-ink-faint">
        <span className="text-ink-soft">$ {service.command}</span>
        <span>{service.cwd === "." ? "workspace root" : service.cwd}</span>
        {git?.isRepo ? (
          <span>
            {git.branch ?? "detached"}
            {git.ahead > 0 ? ` ↑${git.ahead}` : ""}
            {git.behind > 0 ? ` ↓${git.behind}` : ""}
            {git.dirty > 0 ? ` · ${git.dirty} dirty` : " · clean"}
          </span>
        ) : (
          <span>not a git repository</span>
        )}
        {shared.length > 0 ? (
          <span
            className="text-amber-700"
            title={`Also configured on port ${service.port}: ${shared.join(", ")}. Only one of them can run at a time.`}
          >
            port {service.port} shared with {shared.length} other{shared.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function DetailPanel(props: Props) {
  const {
    snapshot,
    service,
    git,
    entries,
    totalEntries,
    levelCounts,
    level,
    onLevel,
    query,
    onQuery,
    follow,
    onFollow,
    onClear,
    onCopy,
    onAction,
    onOpen,
    editing,
    onEditing,
    onSave,
    onRemove,
    busy,
    notice,
    onDismissNotice,
    searchRef,
    conflict,
    onResolveConflict,
    onDismissConflict,
  } = props;

  const runtime = service ? snapshot.runtime[service.id] : null;
  const isRunning = runtime?.status === "running" || runtime?.status === "starting";
  const disabled = busy !== null;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b border-line bg-panel px-4 py-3">
        {service ? <ServiceHeader service={service} snapshot={snapshot} git={git} /> : <CombinedHeader snapshot={snapshot} />}

        {service ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button tone="primary" onClick={() => onAction("start")} disabled={disabled || isRunning} shortcut="s">
              Start
            </Button>
            <Button onClick={() => onAction("restart")} disabled={disabled} shortcut="r">
              Restart
            </Button>
            <Button onClick={() => onAction("stop")} disabled={disabled || !isRunning} shortcut="x">
              Stop
            </Button>
            <Button onClick={() => onAction("pull")} disabled={disabled} shortcut="p">
              {runtime?.busy === "pulling" ? "Pulling…" : "Pull"}
            </Button>
            <Button onClick={() => onAction("install")} disabled={disabled} shortcut="i">
              {runtime?.busy === "installing" ? "Installing…" : "Install deps"}
            </Button>
            <Button onClick={onOpen} disabled={!service.port && !service.url} shortcut="o">
              Open
            </Button>
            <Button tone="ghost" onClick={() => onEditing(!editing)}>
              {editing ? "Close" : "Edit"}
            </Button>
          </div>
        ) : null}
      </div>

      {conflict && service && conflict.serviceId === service.id ? (
        <ConflictPanel
          conflict={conflict}
          serviceName={service.name}
          busy={disabled}
          onResolve={onResolveConflict}
          onDismiss={onDismissConflict}
          onEdit={() => {
            onDismissConflict();
            onEditing(true);
          }}
        />
      ) : null}

      {notice ? (
        <div
          role="alert"
          className={`flex items-start gap-3 border-b px-4 py-2 text-sm ${
            notice.level === "error"
              ? "border-red-200 bg-red-50 text-red-800"
              : notice.level === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-line bg-accent-soft text-ink"
          }`}
        >
          <span className="min-w-0 flex-1">{notice.message}</span>
          <button type="button" onClick={onDismissNotice} aria-label="Dismiss message" className="shrink-0 opacity-60 hover:opacity-100">
            ✕
          </button>
        </div>
      ) : null}

      {editing && service ? (
        <ServiceEditor
          key={service.id}
          service={service}
          allServices={snapshot.services}
          onSave={onSave}
          onRemove={onRemove}
          onClose={() => onEditing(false)}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel-soft px-4 py-2">
        <div className="flex items-center gap-1" role="group" aria-label="Log level filter">
          {LEVEL_FILTERS.map((option) => {
            const count = option === "all" ? totalEntries : levelCounts[option];
            const active = level === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => onLevel(option)}
                aria-pressed={active}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  active ? PILL_ACTIVE[option] : "bg-panel text-ink-soft ring-1 ring-line-strong ring-inset hover:bg-slate-100"
                }`}
              >
                {option}
                <span className={`ml-1.5 font-mono text-[10px] ${active ? "opacity-80" : "text-ink-faint"}`}>{count}</span>
              </button>
            );
          })}
        </div>

        <input
          ref={searchRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="search output   /"
          aria-label="Search log output"
          className="w-52 rounded-[10px] border border-line-strong bg-panel px-2.5 py-1 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
        />

        <span className="font-mono text-xs text-ink-faint">
          {entries.length} / {totalEntries} lines
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onFollow(!follow)}
            aria-pressed={follow}
            className={`rounded-[10px] px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
              follow ? "bg-accent-soft text-accent ring-accent/30" : "bg-panel text-ink-soft ring-line-strong hover:bg-slate-100"
            }`}
          >
            {follow ? "Following" : "Paused"}
            <kbd className="ml-1.5 font-mono text-[10px] opacity-60">f</kbd>
          </button>
          <Button tone="ghost" className="px-2 py-1 text-xs" onClick={onCopy}>
            Copy
          </Button>
          <Button tone="ghost" className="px-2 py-1 text-xs" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>

      <LogPane
        entries={entries}
        follow={follow}
        showService={service === null}
        emptyHint={
          totalEntries === 0
            ? service
              ? runtime?.adopted
                ? `${service.name} was started outside this console, so its output is going to wherever it was launched. Restart it here to capture output.`
                : `No output yet for ${service.name}. Press Start, or "s".`
              : "No output yet. Start a service to see its output here."
            : "No lines match the current filter."
        }
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-panel px-4 py-1.5 font-mono text-[11px] text-ink-faint">
        <span>
          logs → {snapshot.logDir}/{service ? service.id : "<service>"}.log
        </span>
        <span className="ml-auto">
          shortcuts: s start · r restart · x stop · p pull · i install · o open · f follow · / search · j/k select
        </span>
      </div>
    </section>
  );
}

export { ALL_SERVICES };
