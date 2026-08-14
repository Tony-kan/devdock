"use client";

import { useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import type { ServiceConfig } from "@/lib/types";

interface EnvRow {
  key: string;
  value: string;
  /** Stable React key so rows are not re-keyed by index when one is removed. */
  rowId: string;
}

function toRows(env: Record<string, string> | undefined): EnvRow[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({ key, value, rowId: crypto.randomUUID() }));
}

export function ServiceEditor({
  service,
  allServices,
  onSave,
  onRemove,
  onClose,
}: {
  service: ServiceConfig;
  allServices: ServiceConfig[];
  onSave: (patch: Partial<ServiceConfig> & { env: Record<string, string> }) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(service.name);
  const [command, setCommand] = useState(service.command);
  const [cwd, setCwd] = useState(service.cwd);
  const [port, setPort] = useState(service.port ? String(service.port) : "");
  const [healthPath, setHealthPath] = useState(service.healthPath ?? "");
  const [url, setUrl] = useState(service.url ?? "");
  const [autoStart, setAutoStart] = useState(service.autoStart === true);
  const [dependsOn, setDependsOn] = useState<string[]>(service.dependsOn ?? []);
  const [rows, setRows] = useState<EnvRow[]>(() => toRows(service.env));
  const [saving, setSaving] = useState(false);

  // Every field is seeded from `service` on mount only. The parent gives this
  // component a `key` of the service id, so selecting a different service remounts
  // it with fresh values instead of resetting state from an effect.

  const save = async () => {
    setSaving(true);
    try {
      const env: Record<string, string> = {};
      for (const row of rows) {
        if (row.key.trim()) env[row.key.trim()] = row.value;
      }
      await onSave({
        name: name.trim() || service.name,
        command: command.trim() || service.command,
        cwd: cwd.trim() || ".",
        port: port.trim() ? Number(port) : null,
        healthPath: healthPath.trim() || null,
        url: url.trim() || null,
        autoStart,
        dependsOn,
        env,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove "${service.name}" from the console? Its files are not touched.`)) return;
    setSaving(true);
    try {
      await onRemove();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-b border-line bg-panel-soft px-4 py-3">
      <div className="flex flex-wrap gap-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Working directory" hint="relative to the workspace root">
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} className={inputClass} />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Command">
          <input value={command} onChange={(e) => setCommand(e.target.value)} className={inputClass} />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        <div className="w-24 shrink-0">
          <Field label="Port">
            <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className={inputClass} />
          </Field>
        </div>
        <div className="w-44 shrink-0">
          <Field label="Health path">
            <input
              value={healthPath}
              onChange={(e) => setHealthPath(e.target.value)}
              placeholder="/actuator/health"
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Open URL" hint="defaults to http://localhost:<port>">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="(default)" className={inputClass} />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <fieldset className="min-w-0 flex-1">
          <legend className="text-xs font-medium text-ink-soft">Depends on</legend>
          <div className="scroll-slim mt-1 max-h-24 overflow-y-auto rounded-[10px] border border-line-strong bg-panel px-2 py-1.5">
            {allServices.filter((s) => s.id !== service.id).length === 0 ? (
              <p className="text-xs text-ink-faint">No other services configured.</p>
            ) : (
              allServices
                .filter((s) => s.id !== service.id)
                .map((other) => (
                  <label key={other.id} className="flex items-center gap-2 py-0.5 font-mono text-xs text-ink-soft">
                    <input
                      type="checkbox"
                      checked={dependsOn.includes(other.id)}
                      onChange={(e) =>
                        setDependsOn((current) =>
                          e.target.checked ? [...current, other.id] : current.filter((id) => id !== other.id),
                        )
                      }
                    />
                    {other.id}
                  </label>
                ))
            )}
          </div>
        </fieldset>

        <fieldset className="min-w-0 flex-1">
          <legend className="text-xs font-medium text-ink-soft">Environment variables</legend>
          <div className="mt-1 flex flex-col gap-1.5">
            {rows.map((row, index) => (
              <div key={row.rowId} className="flex items-center gap-1.5">
                <input
                  value={row.key}
                  onChange={(e) =>
                    setRows((current) => current.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))
                  }
                  placeholder="KEY"
                  aria-label="Variable name"
                  className={`${inputClass} w-40`}
                />
                <input
                  value={row.value}
                  onChange={(e) =>
                    setRows((current) => current.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))
                  }
                  placeholder="value"
                  aria-label="Variable value"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  aria-label={`Remove ${row.key || "variable"}`}
                  className="rounded px-2 py-1 text-sm text-ink-faint hover:bg-slate-200 hover:text-red-700"
                >
                  ✕
                </button>
              </div>
            ))}
            <Button
              tone="ghost"
              className="self-start px-2 py-1 text-xs"
              onClick={() => setRows((current) => [...current, { key: "", value: "", rowId: crypto.randomUUID() }])}
            >
              + Add variable
            </Button>
          </div>
        </fieldset>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="mr-2 flex items-center gap-2 text-xs text-ink-soft">
          <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
          Start automatically when the console boots
        </label>
        <Button tone="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button tone="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button tone="danger" className="ml-auto" onClick={remove} disabled={saving}>
          Remove service
        </Button>
      </div>
    </div>
  );
}
