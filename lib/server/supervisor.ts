import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { LOG_DIR, STATE_PATH, resolveIn } from "./paths";
import { describeHolder, isPortInUse, whoHoldsPort } from "./ports";
import type { LogStore } from "./logs";
import type { ActionResult, ConsoleConfig, HealthState, ServiceConfig, ServiceRuntime, ServiceStatus } from "../types";

/** A live PID counts as running once it has survived this long. */
const SETTLE_MS = 1500;
/** SIGTERM first, SIGKILL after this. */
const GRACE_MS = 8000;
const HEALTH_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 2500;
/** How long "start all" waits for one dependency before moving on. */
const DEPENDENCY_TIMEOUT_MS = 90_000;
/** Extra settle time for a dependency with no health endpoint to prove itself with. */
const BLIND_DEPENDENCY_GRACE_MS = 5000;

interface Managed {
  id: string;
  child: ChildProcess | null;
  pid: number | null;
  pgid: number | null;
  command: string;
  status: ServiceStatus;
  startedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  starts: number;
  health: HealthState;
  lastHealthAt: number | null;
  busy: string | null;
  /** Set while a stop we asked for is in flight, so the exit is not read as a crash. */
  stopping: boolean;
  settleTimer: NodeJS.Timeout | null;
}

interface PersistedProcess {
  id: string;
  pid: number;
  pgid: number;
  command: string;
  startedAt: number;
}

function emptyManaged(id: string, command: string): Managed {
  return {
    id,
    child: null,
    pid: null,
    pgid: null,
    command,
    status: "stopped",
    startedAt: null,
    exitCode: null,
    exitSignal: null,
    starts: 0,
    health: "unknown",
    lastHealthAt: null,
    busy: null,
    stopping: false,
    settleTimer: null,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Supervisor {
  private processes = new Map<string, Managed>();
  private healthTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    private logs: LogStore,
    private getConfig: () => ConsoleConfig,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  init(): void {
    this.reapOrphans();
    this.healthTimer = setInterval(() => void this.pollHealth(), HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  /**
   * Kill process groups left behind by a previous console that died without
   * cleaning up. A recorded pid is only killed when /proc still shows the same
   * command line, so a recycled pid cannot be mistaken for ours.
   */
  private reapOrphans(): void {
    let records: PersistedProcess[] = [];
    try {
      records = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as PersistedProcess[];
    } catch {
      return;
    }
    for (const record of records) {
      let cmdline = "";
      try {
        cmdline = fs.readFileSync(`/proc/${record.pid}/cmdline`, "utf8").replace(/\0/g, " ");
      } catch {
        continue;
      }
      if (!cmdline.includes(record.command)) continue;
      try {
        process.kill(-record.pgid, "SIGKILL");
        this.logs.console("warn", `Reaped orphaned "${record.id}" (pid ${record.pid}) left by a previous console run.`);
      } catch {
        // Gone between the check and the kill — nothing to do.
      }
    }
    this.persistState();
  }

  private persistState(): void {
    const records: PersistedProcess[] = [];
    for (const managed of this.processes.values()) {
      if (managed.pid && managed.pgid && managed.startedAt && managed.status !== "stopped" && managed.status !== "crashed") {
        records.push({
          id: managed.id,
          pid: managed.pid,
          pgid: managed.pgid,
          command: managed.command,
          startedAt: managed.startedAt,
        });
      }
    }
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(STATE_PATH, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    } catch {
      // Losing the crash-recovery record is not worth failing an action over.
    }
  }

  /** Send SIGTERM to every process group we own. Used on console shutdown. */
  terminateAll(): void {
    this.shuttingDown = true;
    for (const managed of this.processes.values()) this.signal(managed, "SIGTERM");
  }

  /** Synchronous last resort, safe to call from a `process.on("exit")` handler. */
  killAllSync(): void {
    for (const managed of this.processes.values()) this.signal(managed, "SIGKILL");
  }

  // ------------------------------------------------------------------ helpers

  private signal(managed: Managed, sig: NodeJS.Signals): void {
    if (!managed.pgid) return;
    try {
      // Negative pid targets the whole group: gradlew -> java, npm -> vite, etc.
      process.kill(-managed.pgid, sig);
    } catch {
      try {
        if (managed.pid) process.kill(managed.pid, sig);
      } catch {
        // Already gone.
      }
    }
  }

  private isAlive(managed: Managed): boolean {
    if (!managed.pid) return false;
    try {
      process.kill(managed.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private managed(service: ServiceConfig): Managed {
    let managed = this.processes.get(service.id);
    if (!managed) {
      managed = emptyManaged(service.id, service.command);
      this.processes.set(service.id, managed);
    }
    return managed;
  }

  private find(id: string): ServiceConfig | null {
    return this.getConfig().services.find((s) => s.id === id) ?? null;
  }

  private log(service: string, level: "info" | "warn" | "error", text: string): void {
    this.logs.append(service, level, text);
  }

  // -------------------------------------------------------------------- state

  runtimeFor(service: ServiceConfig): ServiceRuntime {
    const managed = this.processes.get(service.id);
    if (!managed) {
      return {
        id: service.id,
        status: "stopped",
        pid: null,
        startedAt: null,
        uptimeMs: 0,
        exitCode: null,
        exitSignal: null,
        restarts: 0,
        health: service.healthPath ? "unknown" : "n/a",
        lastHealthAt: null,
        busy: null,
      };
    }
    const running = managed.status === "running" || managed.status === "starting";
    return {
      id: service.id,
      status: managed.status,
      pid: managed.pid,
      startedAt: managed.startedAt,
      uptimeMs: running && managed.startedAt ? Date.now() - managed.startedAt : 0,
      exitCode: managed.exitCode,
      exitSignal: managed.exitSignal,
      restarts: Math.max(0, managed.starts - 1),
      health: service.healthPath ? managed.health : "n/a",
      lastHealthAt: managed.lastHealthAt,
      busy: managed.busy,
    };
  }

  setBusy(id: string, busy: string | null): void {
    const service = this.find(id);
    if (!service) return;
    this.managed(service).busy = busy;
  }

  // -------------------------------------------------------------------- start

  async start(service: ServiceConfig): Promise<ActionResult> {
    const managed = this.managed(service);
    managed.command = service.command;

    if (this.isAlive(managed) && !managed.stopping) {
      const message = `${service.name} is already running (pid ${managed.pid}).`;
      this.log(service.id, "warn", message);
      return { ok: false, message };
    }

    const config = this.getConfig();
    const cwd = resolveIn(config.root, service.cwd);
    if (!fs.existsSync(cwd)) {
      const message = `Cannot start ${service.name}: working directory ${cwd} does not exist.`;
      this.log(service.id, "error", message);
      return { ok: false, message };
    }

    if (service.port) {
      const inUse = await isPortInUse(service.port);
      if (inUse) {
        const holder = await whoHoldsPort(service.port);
        const ours = holder?.pid ? this.serviceHoldingPid(holder.pid) : null;
        const by = ours ? `"${ours}" started here (pid ${holder?.pid})` : describeHolder(holder);
        const message = `Port ${service.port} is already in use by ${by}. ${service.name} was not started.`;
        this.log(service.id, "error", message);
        return { ok: false, message };
      }
    }

    const env: Record<string, string> = {
      // Keep ANSI colour sequences out of the log pane.
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...service.env,
    };

    this.log(service.id, "info", `$ ${service.command}`);
    this.log(service.id, "info", `  (cwd ${cwd}${service.port ? `, port ${service.port}` : ""})`);

    let child: ChildProcess;
    try {
      child = spawn(service.command, {
        cwd,
        env: { ...process.env, ...env },
        shell: true,
        // Its own process group, so stopping kills the whole tree rather than just the shell.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = `Failed to spawn ${service.name}: ${error instanceof Error ? error.message : String(error)}`;
      this.log(service.id, "error", message);
      managed.status = "crashed";
      return { ok: false, message };
    }

    managed.child = child;
    managed.pid = child.pid ?? null;
    managed.pgid = child.pid ?? null;
    managed.status = "starting";
    managed.startedAt = Date.now();
    managed.exitCode = null;
    managed.exitSignal = null;
    managed.stopping = false;
    managed.health = "unknown";
    managed.starts += 1;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.logs.appendOutput(service.id, chunk, "stdout"));
    child.stderr?.on("data", (chunk: string) => this.logs.appendOutput(service.id, chunk, "stderr"));

    child.on("error", (error) => {
      this.log(service.id, "error", `${service.name}: ${error.message}`);
    });

    child.on("close", (code, signal) => {
      if (managed.settleTimer) {
        clearTimeout(managed.settleTimer);
        managed.settleTimer = null;
      }
      managed.child = null;
      managed.pid = null;
      managed.pgid = null;
      managed.exitCode = code;
      managed.exitSignal = signal;
      const requested = managed.stopping;
      managed.stopping = false;
      managed.health = "unknown";
      managed.startedAt = null;

      if (requested) {
        managed.status = "stopped";
        this.log(service.id, "info", `${service.name} stopped.`);
      } else if (code === 0) {
        managed.status = "stopped";
        this.log(service.id, "info", `${service.name} exited normally (code 0).`);
      } else {
        managed.status = "crashed";
        const how = signal ? `signal ${signal}` : `exit code ${code}`;
        this.log(service.id, "error", `${service.name} crashed (${how}).`);
      }
      this.persistState();
    });

    managed.settleTimer = setTimeout(() => {
      managed.settleTimer = null;
      if (managed.status === "starting" && this.isAlive(managed)) {
        managed.status = "running";
        this.log(service.id, "info", `${service.name} is running (pid ${managed.pid}).`);
      }
    }, SETTLE_MS);
    managed.settleTimer.unref?.();

    this.persistState();
    return { ok: true, message: `Starting ${service.name}…` };
  }

  private serviceHoldingPid(pid: number): string | null {
    for (const managed of this.processes.values()) {
      if (managed.pid === pid) return managed.id;
    }
    return null;
  }

  // --------------------------------------------------------------------- stop

  async stop(service: ServiceConfig, graceMs = GRACE_MS): Promise<ActionResult> {
    const managed = this.managed(service);
    if (!this.isAlive(managed)) {
      managed.status = managed.status === "crashed" ? "crashed" : "stopped";
      const message = `${service.name} is not running.`;
      this.log(service.id, "warn", message);
      return { ok: false, message };
    }

    managed.stopping = true;
    managed.busy = "stopping";
    this.log(service.id, "info", `$ kill -TERM -${managed.pgid}   (SIGTERM to the process group)`);
    this.signal(managed, "SIGTERM");

    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && this.isAlive(managed)) await sleep(200);

    if (this.isAlive(managed)) {
      this.log(service.id, "warn", `${service.name} ignored SIGTERM for ${graceMs}ms — sending SIGKILL.`);
      this.signal(managed, "SIGKILL");
      const killDeadline = Date.now() + 3000;
      while (Date.now() < killDeadline && this.isAlive(managed)) await sleep(100);
    }

    managed.busy = null;
    this.persistState();
    return { ok: true, message: `Stopped ${service.name}.` };
  }

  async restart(service: ServiceConfig): Promise<ActionResult> {
    const managed = this.managed(service);
    if (this.isAlive(managed)) await this.stop(service);
    // Give the OS a moment to release the listening socket before rebinding it.
    await sleep(500);
    return this.start(service);
  }

  // ---------------------------------------------------------- bulk operations

  /** Start every service in dependency order, waiting for each dependency to come up. */
  async startAll(ordered: ServiceConfig[]): Promise<ActionResult> {
    const dependencies = new Set<string>();
    for (const service of ordered) for (const dep of service.dependsOn ?? []) dependencies.add(dep);

    let started = 0;
    let skipped = 0;
    for (const service of ordered) {
      const managed = this.managed(service);
      if (this.isAlive(managed)) {
        skipped += 1;
        continue;
      }
      const result = await this.start(service);
      if (!result.ok) {
        skipped += 1;
        continue;
      }
      started += 1;
      if (dependencies.has(service.id)) await this.waitUntilUsable(service);
    }

    const message = `Start all: ${started} started, ${skipped} skipped.`;
    this.logs.console(started > 0 ? "info" : "warn", message);
    return { ok: started > 0, message };
  }

  /** Wait for a dependency to look usable before starting whatever needs it. */
  private async waitUntilUsable(service: ServiceConfig): Promise<void> {
    const managed = this.managed(service);
    const deadline = Date.now() + DEPENDENCY_TIMEOUT_MS;

    if (!service.healthPath || !service.port) {
      this.log(service.id, "info", `Waiting ${BLIND_DEPENDENCY_GRACE_MS}ms for ${service.name} — it has no health endpoint to check.`);
      await sleep(BLIND_DEPENDENCY_GRACE_MS);
      return;
    }

    this.log(service.id, "info", `Waiting for ${service.name} health check at ${service.healthPath}…`);
    while (Date.now() < deadline) {
      if (!this.isAlive(managed)) {
        this.log(service.id, "error", `${service.name} exited while starting — dependants will start anyway.`);
        return;
      }
      if (await this.checkHealth(service, managed)) {
        this.log(service.id, "info", `${service.name} is healthy.`);
        return;
      }
      await sleep(1500);
    }
    this.log(service.id, "warn", `${service.name} did not pass its health check within ${DEPENDENCY_TIMEOUT_MS / 1000}s — continuing anyway.`);
  }

  async stopAll(ordered: ServiceConfig[]): Promise<ActionResult> {
    // Reverse dependency order: dependants go down before what they depend on.
    const reversed = [...ordered].reverse();
    let stopped = 0;
    for (const service of reversed) {
      if (!this.isAlive(this.managed(service))) continue;
      const result = await this.stop(service);
      if (result.ok) stopped += 1;
    }
    const message = `Stop all: ${stopped} stopped.`;
    this.logs.console("info", message);
    return { ok: true, message };
  }

  // ------------------------------------------------------------------- health

  private async checkHealth(service: ServiceConfig, managed: Managed): Promise<boolean> {
    if (!service.port || !service.healthPath) {
      managed.health = "n/a";
      return false;
    }
    const url = `http://127.0.0.1:${service.port}${service.healthPath.startsWith("/") ? "" : "/"}${service.healthPath}`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        headers: { accept: "*/*" },
      });
      managed.health = response.ok ? "pass" : "fail";
    } catch {
      managed.health = "fail";
    }
    managed.lastHealthAt = Date.now();
    return managed.health === "pass";
  }

  private async pollHealth(): Promise<void> {
    if (this.shuttingDown) return;
    const services = this.getConfig().services;
    await Promise.allSettled(
      services.map(async (service) => {
        const managed = this.processes.get(service.id);
        if (!managed) return;
        if (!this.isAlive(managed)) {
          if (managed.status === "running" || managed.status === "starting") {
            // The close handler normally covers this; this is the backstop.
            managed.health = "unknown";
          }
          return;
        }
        if (!service.port || !service.healthPath) {
          managed.health = "n/a";
          return;
        }
        await this.checkHealth(service, managed);
      }),
    );
  }

  /** Drop bookkeeping for a service that has been removed from the config. */
  forget(id: string): void {
    const managed = this.processes.get(id);
    if (managed && this.isAlive(managed)) this.signal(managed, "SIGTERM");
    this.processes.delete(id);
    this.persistState();
  }
}
