/**
 * Types shared by the server core and the browser UI.
 * Keep this file free of Node imports — it is bundled into the client.
 */

export type ServiceKind = "Spring" | "Node" | "Docker" | "Gradle" | "Python" | "Other";

export type ServiceStatus = "stopped" | "starting" | "running" | "crashed";

export type LogLevel = "info" | "warn" | "error";

export type HealthState = "unknown" | "pass" | "fail" | "n/a";

/** One entry in services.json. */
export interface ServiceConfig {
  id: string;
  name: string;
  kind: ServiceKind;
  /** Working directory the command runs in. Relative paths resolve against `root`. */
  cwd: string;
  command: string;
  port?: number | null;
  env?: Record<string, string>;
  healthPath?: string | null;
  dependsOn?: string[];
  autoStart?: boolean;
  /**
   * Git repository this service belongs to, relative to `root`.
   * Defaults to `cwd` — set it when the service lives in a subdirectory of a repo.
   */
  repo?: string | null;
  /** Overrides the `http://127.0.0.1:<port>` URL used by "Open". */
  url?: string | null;
}

export interface ConsoleConfig {
  /** Absolute path to the workspace this console controls. */
  root: string;
  services: ServiceConfig[];
}

export interface ServiceRuntime {
  id: string;
  status: ServiceStatus;
  pid: number | null;
  startedAt: number | null;
  uptimeMs: number;
  exitCode: number | null;
  exitSignal: string | null;
  restarts: number;
  health: HealthState;
  lastHealthAt: number | null;
  /** Set while a blocking action runs, e.g. "pulling", "installing", "stopping". */
  busy: string | null;
}

export interface GitInfo {
  /** Path relative to root, or "." for the root itself. */
  repo: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Number of changed files reported by `git status --porcelain`. */
  dirty: number;
  isRepo: boolean;
  error: string | null;
  checkedAt: number;
}

export interface LogEntry {
  seq: number;
  ts: number;
  /** Service id, or "console" for the console's own messages. */
  service: string;
  level: LogLevel;
  text: string;
}

export interface Snapshot {
  root: string;
  services: ServiceConfig[];
  runtime: Record<string, ServiceRuntime>;
  git: Record<string, GitInfo>;
  counts: {
    running: number;
    total: number;
    errors: number;
    repos: number;
    dirtyRepos: number;
    behindRepos: number;
  };
  lastPullAt: number | null;
  configPath: string;
  logDir: string;
}

/** Result shape returned by every action endpoint. */
export interface ActionResult {
  ok: boolean;
  message: string;
  /** True when a pull touched a lockfile or build file and deps should be installed. */
  needsInstall?: boolean;
  conflicts?: boolean;
}

export const CONSOLE_LOG_SERVICE = "console";
export const ALL_SERVICES = "__all__";
