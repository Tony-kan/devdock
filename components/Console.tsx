"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { StatStrip } from "@/components/StatStrip";
import { ServiceList } from "@/components/ServiceList";
import { DetailPanel, type LevelFilter } from "@/components/DetailPanel";
import { formatTime } from "@/components/ui";
import {
  ALL_SERVICES,
  type ActionResult,
  type LogEntry,
  type LogLevel,
  type ServiceConfig,
  type ServiceKind,
  type Snapshot,
} from "@/lib/types";

const CLIENT_LOG_LIMIT = 4000;

interface StreamPayload {
  snapshot?: Snapshot;
  entries?: LogEntry[];
  dropped?: number;
  message?: string;
}

type Notice = { level: LogLevel; message: string } | null;

export function Console({ initial }: { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<string>(ALL_SERVICES);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const service = useMemo(
    () => (selected === ALL_SERVICES ? null : snapshot.services.find((s) => s.id === selected) ?? null),
    [selected, snapshot.services],
  );

  // A service removed elsewhere would leave `selected` pointing at nothing, so the
  // active row is derived rather than corrected in an effect.
  const activeId = service ? service.id : ALL_SERVICES;

  // ------------------------------------------------------------------ streaming

  useEffect(() => {
    const source = new EventSource("/api/stream");

    const onHello = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as StreamPayload;
      if (payload.snapshot) setSnapshot(payload.snapshot);
      if (payload.entries) setEntries(payload.entries.slice(-CLIENT_LOG_LIMIT));
      setConnected(true);
    };

    const onLog = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as StreamPayload;
      if (!payload.entries?.length) return;
      setEntries((current) => {
        const next = current.concat(payload.entries!);
        return next.length > CLIENT_LOG_LIMIT ? next.slice(next.length - CLIENT_LOG_LIMIT) : next;
      });
    };

    const onState = (event: MessageEvent<string>) => {
      setSnapshot(JSON.parse(event.data) as Snapshot);
      setConnected(true);
    };

    const onServerError = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as StreamPayload;
      setNotice({ level: "error", message: payload.message ?? "The console reported an error." });
    };

    source.addEventListener("hello", onHello);
    source.addEventListener("log", onLog);
    source.addEventListener("state", onState);
    source.addEventListener("server-error", onServerError);
    source.addEventListener("open", () => setConnected(true));
    // Transport failures land here; EventSource retries on its own.
    source.addEventListener("error", () => setConnected(false));

    return () => source.close();
  }, []);

  // -------------------------------------------------------------------- actions

  const applyResult = useCallback((result: ActionResult & { snapshot?: Snapshot }) => {
    if (result.snapshot) setSnapshot(result.snapshot);
    if (!result.ok) {
      setNotice({ level: "error", message: result.message });
      return;
    }
    if (result.conflicts) {
      setNotice({ level: "error", message: result.message });
      return;
    }
    if (result.needsInstall) {
      setNotice({ level: "warn", message: `${result.message} Run "Install deps" before starting it again.` });
      return;
    }
    setNotice({ level: "info", message: result.message });
  }, []);

  const post = useCallback(
    async (key: string, url: string, init?: RequestInit) => {
      setBusy(key);
      try {
        const response = await fetch(url, { method: "POST", ...init });
        const body = (await response.json()) as ActionResult & { snapshot?: Snapshot };
        applyResult(body);
        return body;
      } catch (error) {
        setNotice({
          level: "error",
          message: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [applyResult],
  );

  const serviceAction = useCallback(
    (action: "start" | "stop" | "restart" | "pull" | "install") => {
      if (!service) return;
      void post(`${service.id}:${action}`, `/api/services/${encodeURIComponent(service.id)}/${action}`);
    },
    [post, service],
  );

  const openService = useCallback(() => {
    if (!service) return;
    const url = service.url ?? (service.port ? `http://127.0.0.1:${service.port}` : null);
    if (!url) {
      setNotice({ level: "warn", message: `${service.name} has no port or URL configured.` });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [service]);

  const clearLogs = useCallback(async () => {
    const target = service ? `?service=${encodeURIComponent(service.id)}` : "";
    try {
      await fetch(`/api/logs${target}`, { method: "DELETE" });
      setEntries((current) => (service ? current.filter((e) => e.service !== service.id) : []));
    } catch (error) {
      setNotice({
        level: "error",
        message: `Could not clear the buffer: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [service]);

  const saveService = useCallback(
    async (patch: Partial<ServiceConfig> & { env: Record<string, string> }) => {
      if (!service) return;
      setBusy(`${service.id}:save`);
      try {
        const response = await fetch(`/api/services/${encodeURIComponent(service.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        applyResult((await response.json()) as ActionResult & { snapshot?: Snapshot });
      } catch (error) {
        setNotice({
          level: "error",
          message: `Could not save: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        setBusy(null);
      }
    },
    [applyResult, service],
  );

  const removeService = useCallback(async () => {
    if (!service) return;
    setBusy(`${service.id}:remove`);
    try {
      const response = await fetch(`/api/services/${encodeURIComponent(service.id)}`, { method: "DELETE" });
      applyResult((await response.json()) as ActionResult & { snapshot?: Snapshot });
      setSelected(ALL_SERVICES);
      setEditing(false);
    } catch (error) {
      setNotice({
        level: "error",
        message: `Could not remove: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setBusy(null);
    }
  }, [applyResult, service]);

  const addService = useCallback(
    async (draft: { name: string; command: string; port: string; cwd: string; kind: ServiceKind }) => {
      await post("add", "/api/services", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          command: draft.command,
          port: draft.port ? Number(draft.port) : null,
          cwd: draft.cwd,
          kind: draft.kind,
        }),
      });
    },
    [post],
  );

  const reorder = useCallback(
    (id: string, direction: -1 | 1) => {
      const ids = snapshot.services.map((s) => s.id);
      const from = ids.indexOf(id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      void fetch("/api/services", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      })
        .then((response) => response.json())
        .then((body: ActionResult & { snapshot?: Snapshot }) => {
          if (body.snapshot) setSnapshot(body.snapshot);
        })
        .catch((error: unknown) => {
          setNotice({
            level: "error",
            message: `Could not save the new order: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
    },
    [snapshot.services],
  );

  // ------------------------------------------------------------------ filtering

  const scoped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (service && entry.service !== service.id) return false;
      if (!needle) return true;
      return entry.text.toLowerCase().includes(needle) || entry.service.toLowerCase().includes(needle);
    });
  }, [entries, query, service]);

  const levelCounts = useMemo(() => {
    const counts: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 };
    for (const entry of scoped) counts[entry.level] += 1;
    return counts;
  }, [scoped]);

  const visible = useMemo(() => (level === "all" ? scoped : scoped.filter((e) => e.level === level)), [level, scoped]);

  const copyVisible = useCallback(() => {
    const text = visible
      .map((entry) => `${formatTime(entry.ts)} · ${entry.service} · ${entry.level.toUpperCase()} · ${entry.text}`)
      .join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => setNotice({ level: "info", message: `Copied ${visible.length} lines to the clipboard.` }))
      .catch(() => setNotice({ level: "error", message: "The browser refused clipboard access." }));
  }, [visible]);

  // ------------------------------------------------------------------ shortcuts

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;

      if (event.key === "Escape") {
        if (typing) target?.blur();
        else setEditing(false);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      const ids = [ALL_SERVICES, ...snapshot.services.map((s) => s.id)];
      const index = ids.indexOf(activeId);

      switch (event.key) {
        case "s":
          event.preventDefault();
          serviceAction("start");
          break;
        case "x":
          event.preventDefault();
          serviceAction("stop");
          break;
        case "r":
          event.preventDefault();
          serviceAction("restart");
          break;
        case "p":
          event.preventDefault();
          serviceAction("pull");
          break;
        case "i":
          event.preventDefault();
          serviceAction("install");
          break;
        case "o":
          event.preventDefault();
          openService();
          break;
        case "f":
          event.preventDefault();
          setFollow((v) => !v);
          break;
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          break;
        case "j":
        case "ArrowDown":
          event.preventDefault();
          setSelected(ids[Math.min(ids.length - 1, index + 1)]);
          break;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          setSelected(ids[Math.max(0, index - 1)]);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeId, openService, serviceAction, snapshot.services]);

  // Informational notices fade; errors and warnings stay until dismissed.
  useEffect(() => {
    if (!notice || notice.level !== "info") return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const focusedGit = service ? snapshot.git[service.repo || service.cwd] ?? null : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TopBar
        snapshot={snapshot}
        focusedGit={focusedGit}
        busy={busy}
        onPullAll={() => void post("pull-all", "/api/bulk/pull-all")}
        onStartAll={() => void post("start-all", "/api/bulk/start-all")}
        onStopAll={() => void post("stop-all", "/api/bulk/stop-all")}
      />
      <StatStrip snapshot={snapshot} connected={connected} />

      <div className="flex min-h-0 flex-1">
        <ServiceList
          snapshot={snapshot}
          selected={activeId}
          onSelect={(id) => {
            setSelected(id);
            setEditing(false);
          }}
          onAdd={addService}
          onReorder={reorder}
          onRescan={() =>
            void post("rescan", "/api/services", {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ rescan: true }),
            })
          }
          busy={busy}
        />

        <DetailPanel
          snapshot={snapshot}
          service={service}
          git={focusedGit}
          entries={visible}
          totalEntries={scoped.length}
          levelCounts={levelCounts}
          level={level}
          onLevel={setLevel}
          query={query}
          onQuery={setQuery}
          follow={follow}
          onFollow={setFollow}
          onClear={() => void clearLogs()}
          onCopy={copyVisible}
          onAction={serviceAction}
          onOpen={openService}
          editing={editing}
          onEditing={setEditing}
          onSave={saveService}
          onRemove={removeService}
          busy={busy}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          searchRef={searchRef}
        />
      </div>
    </div>
  );
}
