"use client";

import { useState } from "react";
import { Button, HealthDot, KindChip, StatusDot, formatUptime, inputClass } from "@/components/ui";
import { ALL_SERVICES, type ServiceConfig, type ServiceKind, type Snapshot } from "@/lib/types";

/** One row as displayed: the service plus whether it can move inside its status group. */
export interface ServiceRow {
  service: ServiceConfig;
  rank: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

interface Props {
  snapshot: Snapshot;
  /** Pre-ordered by the parent: running first, then crashed, then stopped. */
  rows: ServiceRow[];
  selected: string;
  onSelect: (id: string) => void;
  onAdd: (draft: { name: string; command: string; port: string; cwd: string; kind: ServiceKind }) => Promise<void>;
  onReorder: (id: string, direction: -1 | 1) => void;
  onRescan: () => void;
  busy: string | null;
}

const KINDS: ServiceKind[] = ["Node", "Spring", "Docker", "Gradle", "Python", "Other"];

function AddForm({ onAdd, onCancel }: { onAdd: Props["onAdd"]; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [port, setPort] = useState("");
  const [cwd, setCwd] = useState(".");
  const [kind, setKind] = useState<ServiceKind>("Node");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !command.trim()) return;
    setSaving(true);
    try {
      await onAdd({ name, command, port, cwd, kind });
      setName("");
      setCommand("");
      setPort("");
      setCwd(".");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-b border-line bg-accent-soft/60 px-3 py-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name"
        aria-label="Service name"
        className={inputClass}
      />
      <input
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="command, e.g. npm run dev"
        aria-label="Command"
        className={inputClass}
      />
      <div className="flex gap-2">
        <input
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="port"
          inputMode="numeric"
          aria-label="Port"
          className={`${inputClass} w-20`}
        />
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="path from workspace root"
          aria-label="Working directory"
          className={inputClass}
        />
      </div>
      <div className="flex items-center gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ServiceKind)}
          aria-label="Kind"
          className={`${inputClass} w-28`}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <Button tone="primary" type="submit" disabled={saving || !name.trim() || !command.trim()}>
          {saving ? "Adding…" : "Add"}
        </Button>
        <Button tone="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Row({
  service,
  snapshot,
  selected,
  onSelect,
  onReorder,
  canMoveUp,
  canMoveDown,
}: {
  service: ServiceConfig;
  snapshot: Snapshot;
  selected: boolean;
  onSelect: () => void;
  onReorder: (direction: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const runtime = snapshot.runtime[service.id];
  const status = runtime?.status ?? "stopped";

  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
          selected ? "bg-accent-soft" : "hover:bg-panel-soft"
        }`}
      >
        <StatusDot status={status} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={`truncate text-sm ${selected ? "font-semibold text-ink" : "font-medium text-ink"}`}>
              {service.name}
            </span>
            {/* Health only means something while the process is up. */}
            {status === "running" || status === "starting" ? <HealthDot health={runtime?.health ?? "unknown"} /> : null}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <KindChip kind={service.kind} />
            {service.port ? <span className="font-mono text-[11px] text-ink-faint">:{service.port}</span> : null}
            <span
              className={`text-[11px] ${
                status === "running" ? "text-ok" : status === "crashed" ? "text-bad" : "text-ink-faint"
              }`}
            >
              {runtime?.busy ?? status}
            </span>
            {status === "running" && runtime ? (
              <span className="font-mono text-[11px] text-ink-faint">{formatUptime(runtime.uptimeMs)}</span>
            ) : null}
            {runtime?.adopted ? (
              <span className="text-[11px] text-sky-700" title="Started outside this console and picked up here">
                adopted
              </span>
            ) : null}
            {runtime && runtime.restarts > 0 ? (
              <span className="font-mono text-[11px] text-ink-faint" title="Restart count">
                ×{runtime.restarts}
              </span>
            ) : null}
          </span>
        </span>
      </button>

      <span className="absolute top-1.5 right-1 hidden flex-col group-hover/row:flex">
        <button
          type="button"
          onClick={() => onReorder(-1)}
          disabled={!canMoveUp}
          aria-label={`Move ${service.name} up`}
          className="rounded px-1 text-[10px] leading-tight text-ink-faint hover:bg-slate-200 hover:text-ink disabled:opacity-30"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={() => onReorder(1)}
          disabled={!canMoveDown}
          aria-label={`Move ${service.name} down`}
          className="rounded px-1 text-[10px] leading-tight text-ink-faint hover:bg-slate-200 hover:text-ink disabled:opacity-30"
        >
          ▼
        </button>
      </span>
    </li>
  );
}

export function ServiceList({ snapshot, rows, selected, onSelect, onAdd, onReorder, onRescan, busy }: Props) {
  const [adding, setAdding] = useState(false);
  const runningCount = snapshot.counts.running;

  return (
    <aside className="flex w-66 shrink-0 flex-col border-r border-line bg-panel xl:w-80">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-semibold tracking-wide text-ink-soft uppercase">Services</span>
        {/* The running count lives in the stat strip; repeating it here crowds the row. */}
        <span
          className="font-mono text-[11px] text-ink-faint"
          title={runningCount > 0 ? `${runningCount} running, listed first` : undefined}
        >
          {rows.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button tone="ghost" onClick={onRescan} disabled={busy !== null} className="px-2 py-1 text-xs">
            Re-scan
          </Button>
          <Button tone="primary" onClick={() => setAdding((v) => !v)} className="px-2 py-1 text-xs">
            {adding ? "Close" : "Add"}
          </Button>
        </div>
      </div>

      {adding ? (
        <AddForm
          onAdd={async (draft) => {
            await onAdd(draft);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        <ul>
          <li>
            <button
              type="button"
              onClick={() => onSelect(ALL_SERVICES)}
              aria-current={selected === ALL_SERVICES ? "true" : undefined}
              className={`flex w-full items-center gap-2.5 border-b border-line px-3 py-2.5 text-left transition-colors ${
                selected === ALL_SERVICES ? "bg-accent-soft" : "hover:bg-panel-soft"
              }`}
            >
              <span aria-hidden className="inline-block size-2.5 rounded-full ring-1 ring-line-strong ring-inset" />
              <span className="flex-1 text-sm font-semibold text-ink">All services</span>
              <span className="font-mono text-[11px] text-ink-faint">combined</span>
            </button>
          </li>

          {rows.map((row) => (
            <Row
              key={row.service.id}
              service={row.service}
              snapshot={snapshot}
              selected={selected === row.service.id}
              onSelect={() => onSelect(row.service.id)}
              onReorder={(direction) => onReorder(row.service.id, direction)}
              canMoveUp={row.canMoveUp}
              canMoveDown={row.canMoveDown}
            />
          ))}

          {rows.length === 0 ? (
            <li className="px-3 py-6 text-sm text-ink-faint">
              Nothing configured yet. Use <span className="font-medium text-ink-soft">Add</span> or{" "}
              <span className="font-medium text-ink-soft">Re-scan</span>.
            </li>
          ) : null}
        </ul>
      </div>
    </aside>
  );
}
