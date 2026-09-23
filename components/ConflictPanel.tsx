"use client";

import { useState } from "react";
import { Button, inputClass } from "@/components/ui";
import type { ConflictResolution, PortConflict } from "@/lib/types";

interface Props {
  conflict: PortConflict;
  serviceName: string;
  busy: boolean;
  onResolve: (resolution: ConflictResolution, options: { port?: number; persist?: boolean }) => void;
  onDismiss: () => void;
  onEdit: () => void;
}

function holderSentence(conflict: PortConflict): string {
  const { holder, port } = conflict;
  if (holder.serviceId) {
    return `Port ${port} is held by "${holder.serviceName ?? holder.serviceId}", which this console started${
      holder.pid ? ` (pid ${holder.pid})` : ""
    }.`;
  }
  if (holder.likelyContainer) {
    return `Port ${port} is published by a container, so there is no process this console can signal.`;
  }
  if (holder.pid) {
    return `Port ${port} is held by ${holder.process ?? "an outside process"} (pid ${holder.pid}), which this console did not start.`;
  }
  return `Port ${port} is in use, but the holding process could not be identified.`;
}

/**
 * Shown when a start is refused because the port was taken. Every option here is an
 * explicit choice — the console never reassigns a port or kills anything on its own,
 * because services in a workspace reference each other by port.
 */
export function ConflictPanel({ conflict, serviceName, busy, onResolve, onDismiss, onEdit }: Props) {
  const [port, setPort] = useState(conflict.suggestedPort ? String(conflict.suggestedPort) : "");
  const [persist, setPersist] = useState(false);

  const canMove = conflict.overrideMechanism !== null;
  const parsedPort = Number(port);
  const portValid = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65_536;

  return (
    <section
      role="alert"
      className="border-b border-amber-200 bg-amber-50/80 px-4 py-3"
      aria-label={`Port ${conflict.port} conflict`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold text-amber-900">Port {conflict.port} is in use</h2>
        <span className="text-sm text-amber-800">{serviceName} was not started.</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss the port conflict"
          className="ml-auto shrink-0 text-amber-700 opacity-70 hover:opacity-100"
        >
          ✕
        </button>
      </div>

      <p className="mt-1 font-mono text-xs text-amber-900/80">{holderSentence(conflict)}</p>

      <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-3">
        {conflict.holder.serviceId ? (
          <Button tone="primary" disabled={busy} onClick={() => onResolve("stop-holder", {})}>
            Stop {conflict.holder.serviceName ?? conflict.holder.serviceId} and start
          </Button>
        ) : null}

        {conflict.holder.pid && !conflict.holder.serviceId && !conflict.holder.likelyContainer ? (
          <Button
            tone="danger"
            disabled={busy}
            onClick={() => {
              const label = `${conflict.holder.process ?? "process"} (pid ${conflict.holder.pid})`;
              if (!window.confirm(`Stop ${label}? This console did not start it, so anything it was doing is lost.`)) return;
              onResolve("kill-holder", {});
            }}
          >
            Stop {conflict.holder.process ?? "that process"} (pid {conflict.holder.pid})
          </Button>
        ) : null}

        {canMove ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-amber-900">Start on port</span>
              <input
                value={port}
                onChange={(event) => setPort(event.target.value)}
                inputMode="numeric"
                aria-label="Alternative port"
                className={`${inputClass} w-24`}
              />
            </label>
            <Button disabled={busy || !portValid} onClick={() => onResolve("use-port", { port: parsedPort, persist })}>
              {persist ? "Save port and start" : "Start there"}
            </Button>
            <label className="flex items-center gap-1.5 pb-1.5 text-xs text-amber-900">
              <input type="checkbox" checked={persist} onChange={(event) => setPersist(event.target.checked)} />
              save to services.json
            </label>
          </div>
        ) : (
          <p className="text-xs text-amber-900/80">
            This service&apos;s port comes from its compose file, so it cannot be moved from here.
          </p>
        )}

        <Button tone="ghost" className="ml-auto" onClick={onEdit}>
          Edit service
        </Button>
      </div>

      {canMove ? (
        <p className="mt-2 font-mono text-[11px] text-amber-900/70">
          Moving applies {conflict.overrideMechanism}
          {conflict.suggestedPort ? ` · ${conflict.suggestedPort} is free` : ""}
        </p>
      ) : null}

      {conflict.overrideCaveat ? <p className="mt-1 text-xs text-amber-900">{conflict.overrideCaveat}</p> : null}
    </section>
  );
}
