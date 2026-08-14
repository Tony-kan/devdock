import type { HealthState, ServiceKind, ServiceStatus } from "@/lib/types";

export function formatUptime(ms: number): string {
  if (ms <= 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
}

export function formatClock(ts: number | null): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const STATUS_DOT: Record<ServiceStatus, string> = {
  running: "bg-ok dot-pulse",
  starting: "bg-warn dot-pulse",
  crashed: "bg-bad",
  stopped: "bg-idle",
};

export function StatusDot({ status, className = "" }: { status: ServiceStatus; className?: string }) {
  return <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${STATUS_DOT[status]} ${className}`} />;
}

const STATUS_PILL: Record<ServiceStatus, string> = {
  running: "bg-ok/12 text-emerald-700 ring-ok/30",
  starting: "bg-warn/12 text-amber-700 ring-warn/30",
  crashed: "bg-bad/12 text-red-700 ring-bad/30",
  stopped: "bg-slate-100 text-ink-soft ring-line-strong",
};

export function StatusPill({ status, exitCode }: { status: ServiceStatus; exitCode?: number | null }) {
  const label =
    status === "crashed" && exitCode !== null && exitCode !== undefined ? `crashed · exit ${exitCode}` : status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_PILL[status]}`}
    >
      {label}
    </span>
  );
}

const KIND_CHIP: Record<ServiceKind, string> = {
  Spring: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  Node: "bg-sky-50 text-sky-700 ring-sky-200",
  Docker: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  Gradle: "bg-violet-50 text-violet-700 ring-violet-200",
  Python: "bg-amber-50 text-amber-700 ring-amber-200",
  Other: "bg-slate-50 text-ink-soft ring-line-strong",
};

export function KindChip({ kind }: { kind: ServiceKind }) {
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ring-1 ring-inset ${KIND_CHIP[kind]}`}>
      {kind}
    </span>
  );
}

const HEALTH_TITLE: Record<HealthState, string> = {
  pass: "Health check passing",
  fail: "Health check failing",
  unknown: "Health not yet known",
  "n/a": "No health endpoint configured",
};

export function HealthDot({ health }: { health: HealthState }) {
  if (health === "n/a") return null;
  const colour = health === "pass" ? "bg-ok" : health === "fail" ? "bg-bad" : "bg-line-strong";
  return <span title={HEALTH_TITLE[health]} className={`inline-block size-2 shrink-0 rounded-full ${colour}`} />;
}

type ButtonTone = "primary" | "default" | "danger" | "ghost";

const TONE: Record<ButtonTone, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover disabled:hover:bg-accent",
  default: "bg-panel text-ink ring-1 ring-inset ring-line-strong hover:bg-panel-soft",
  danger: "bg-panel text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-50",
  ghost: "text-ink-soft hover:bg-slate-100",
};

export function Button({
  tone = "default",
  shortcut,
  children,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; shortcut?: string }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${TONE[tone]} ${className}`}
      {...rest}
    >
      {children}
      {shortcut ? <kbd className="ml-0.5 font-mono text-[10px] opacity-55">{shortcut}</kbd> : null}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-xs font-medium text-ink-soft">{label}</span>
      {children}
      {hint ? <span className="font-mono text-[10px] text-ink-faint">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-[10px] border border-line-strong bg-panel px-2.5 py-1.5 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/20";
