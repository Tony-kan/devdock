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
  /**
   * The port this run was actually started on. Differs from the configured port when a
   * clash was resolved by moving the service, so the UI can show which one is live.
   */
  activePort: number | null;
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
  /**
   * Service id → ids of other configured services claiming the same port. Lets the UI
   * warn about a clash before you try to start, not only after it is refused.
   */
  sharedPorts: Record<string, string[]>;
}

/** Whatever is currently holding a port we wanted. */
export interface PortHolder {
  pid: number | null;
  process: string | null;
  /** Set when the holder is a service this console started. */
  serviceId: string | null;
  serviceName: string | null;
  /**
   * True when the port looks container-published. Docker publishes ports from a
   * namespace this process cannot inspect without elevation, so there is no pid to
   * signal — the container has to be stopped instead.
   */
  likelyContainer: boolean;
}

/** Everything the UI needs to offer a way out of a port clash. */
export interface PortConflict {
  serviceId: string;
  port: number;
  holder: PortHolder;
  /** A nearby free port, offered as a one-click alternative. */
  suggestedPort: number | null;
  /** How a port override would be applied, or null when the command cannot take one. */
  overrideMechanism: string | null;
  /** Set when the override mechanism is not guaranteed to reach the process. */
  overrideCaveat: string | null;
}

/** How the user chose to resolve a clash. */
export type ConflictResolution = "stop-holder" | "kill-holder" | "use-port";

/** Result shape returned by every action endpoint. */
export interface ActionResult {
  ok: boolean;
  message: string;
  /** True when a pull touched a lockfile or build file and deps should be installed. */
  needsInstall?: boolean;
  conflicts?: boolean;
  /** Present when a start was refused because the port was taken. */
  conflict?: PortConflict;
}

export const CONSOLE_LOG_SERVICE = "console";
export const ALL_SERVICES = "__all__";
