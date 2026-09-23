import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { LOG_DIR, STATE_PATH, resolveIn } from "./paths";
import {
  cmdlineOf,
  cwdOf,
  describeHolder,
  findFreePort,
  isDescendantOf,
  isPortInUse,
  looksLikeContainer,
  pgidOf,
  startedAtOf,
  whoHoldsPort,
} from "./ports";
import { planPortOverride } from "./portOverride";
import { childEnvironment } from "./exec";
import type { LogStore } from "./logs";
import type {
  ActionResult,
  ConsoleConfig,
  HealthState,
  PortConflict,
  PortHolder,
  ServiceConfig,
  ServiceRuntime,
  ServiceStatus,
} from "../types";

/** A live PID counts as running once it has survived this long. */
const SETTLE_MS = 1500;
/** SIGTERM first, SIGKILL after this. */
const GRACE_MS = 8000;
/**
 * Health polling interval. Kept deliberately unhurried: every poll is a real request,
 * and any service that logs requests writes a line into its own pane because of it.
 */
const HEALTH_INTERVAL_MS = 10_000;
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
  /** The port this run was actually started on — may differ from the configured one. */
  activePort: number | null;
  /** Set while a stop we asked for is in flight, so the exit is not read as a crash. */
  stopping: boolean;
  settleTimer: NodeJS.Timeout | null;
  /** True when we attached to a process started outside the console rather than spawning it. */
  adopted: boolean;
}

interface PersistedProcess {
  id: string;
  pid: number;
  pgid: number;
  command: string;
  startedAt: number;
}

/**
 * The crash-recovery file, keyed by the pid of the console that owns each set of
 * children. Keying by owner is what lets two console instances coexist without one
 * reaping the other's services.
 */
type StateFile = Record<string, { startedAt: number; processes: PersistedProcess[] }>;

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
    activePort: null,
    stopping: false,
    settleTimer: null,
    adopted: false,
  };
}

export interface StartOptions {
  /** Start on this port instead of the configured one, for this run only. */
  portOverride?: number;
}

/** Phrase a holder for a message, naming one of our own services when we can. */
function describeConflictHolder(holder: PortHolder): string {
  if (holder.serviceId) {
    return `"${holder.serviceName ?? holder.serviceId}", which this console started${holder.pid ? ` (pid ${holder.pid})` : ""}`;
  }
  if (holder.likelyContainer) return "a container-published port (no process to signal)";
  return describeHolder(holder);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Supervisor {
  private processes = new Map<string, Managed>();
  private healthTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private bootedAt = Date.now();
  /**
   * Bumped whenever a bulk start should stop. "Start all" walks a long list with an
   * await per service, so without this a "Stop all" pressed midway would stop what was
   * up and then watch the loop keep starting the rest.
   */
  private bulkToken = 0;

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

  /** Read the crash-recovery file, tolerating both absence and a corrupt file. */
  private readState(): StateFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as StateFile;
    } catch {
      // No file yet, or unreadable — either way there is nothing to recover.
    }
    return {};
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kill process groups left behind by a console that died without cleaning up.
   *
   * Records are grouped by the pid of the console that owns them, and only the records
   * of an owner that is **gone** are reaped. Without that check a second console
   * instance — `npm run dev` alongside `npm start`, or two copies of the app — would
   * kill the first one's healthy services on startup, which is exactly what happened
   * before this was keyed by owner.
   *
   * A recorded pid is only killed when /proc still shows the same command line, so a
   * recycled pid cannot be mistaken for ours.
   */
  private reapOrphans(): void {
    const state = this.readState();
    const kept: StateFile = {};

    for (const [ownerKey, entry] of Object.entries(state)) {
      const owner = Number(ownerKey);
      if (owner === process.pid) continue;

      if (this.isProcessAlive(owner)) {
        // Another console is running and these are its children, not orphans.
        kept[ownerKey] = entry;
        this.logs.console(
          "warn",
          `Another console (pid ${owner}) is running and owns ${entry.processes.length} service(s); leaving them alone.`,
        );
        continue;
      }

      for (const record of entry.processes) {
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
    }

    this.persistState(kept);
  }

  /** Record our own children, preserving the entries of any other live console. */
  private persistState(preserve?: StateFile): void {
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

    const state: StateFile = preserve ?? {};
    if (!preserve) {
      // Keep whatever other live consoles have recorded; drop dead owners.
      for (const [ownerKey, entry] of Object.entries(this.readState())) {
        const owner = Number(ownerKey);
        if (owner !== process.pid && this.isProcessAlive(owner)) state[ownerKey] = entry;
      }
    }
    state[String(process.pid)] = { startedAt: this.bootedAt, processes: records };

    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

  /**
   * Drop our own entry from the crash-recovery file on a clean exit.
   *
   * Nothing of ours is orphaned at this point, so leaving records behind would only
   * widen the window in which a recycled pid could match one of them.
   */
  releaseState(): void {
    const state = this.readState();
    delete state[String(process.pid)];
    try {
      fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    } catch {
      // Exiting anyway.
    }
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
        activePort: null,
        adopted: false,
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
      activePort: running ? managed.activePort : null,
      adopted: managed.adopted,
    };
  }

  setBusy(id: string, busy: string | null): void {
    const service = this.find(id);
    if (!service) return;
    this.managed(service).busy = busy;
  }

  // -------------------------------------------------------------------- start

  async start(service: ServiceConfig, options: StartOptions = {}): Promise<ActionResult> {
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

    const port = options.portOverride ?? service.port ?? null;
    let command = service.command;
    const env: Record<string, string> = {
      // Keep ANSI colour sequences out of the log pane.
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...service.env,
    };

    if (options.portOverride) {
      const plan = planPortOverride(service, options.portOverride, cwd);
      if (!plan) {
        const message = `${service.name} cannot be started on a different port from here — its port comes from its compose file.`;
        this.log(service.id, "error", message);
        return { ok: false, message };
      }
      command = plan.command;
      Object.assign(env, plan.env);
      this.log(service.id, "warn", `Port override for this run: ${plan.mechanism} (configured port is ${service.port ?? "unset"}).`);
      if (plan.caveat) this.log(service.id, "warn", plan.caveat);
    }

    if (port) {
      if (await isPortInUse(port)) {
        const conflict = await this.describeConflict(service, port);
        const message = `Port ${port} is already in use by ${describeConflictHolder(conflict.holder)}. ${service.name} was not started.`;
        this.log(service.id, "error", message);
        this.logResolutionHints(service, conflict);
        return { ok: false, message, conflict };
      }
    }

    this.log(service.id, "info", `$ ${command}`);
    this.log(service.id, "info", `  (cwd ${cwd}${port ? `, port ${port}` : ""})`);

    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd,
        env: childEnvironment(env),
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
    managed.activePort = port;
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
      managed.activePort = null;

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

  /**
   * Map a pid found listening on a port back to one of our services. Matching on the
   * process group catches the common case where the listener is a grandchild of the
   * shell we spawned (npm -> vite, gradlew -> java).
   */
  private serviceHoldingPid(pid: number): string | null {
    const group = pgidOf(pid);
    for (const managed of this.processes.values()) {
      if (managed.pid === pid) return managed.id;
      if (group !== null && managed.pgid !== null && managed.pgid === group) return managed.id;
      // Gradle's bootRun forks the app JVM into its own process group, so the group
      // check misses it; the parent chain still leads back to the shell we spawned.
      if (managed.pid !== null && isDescendantOf(pid, managed.pid)) return managed.id;
    }
    return null;
  }

  /**
   * Gather everything needed to offer a way out of a clash: who holds the port, whether
   * it is one of ours, whether it is container-published, and a free port to move to.
   */
  async describeConflict(service: ServiceConfig, port: number): Promise<PortConflict> {
    const config = this.getConfig();
    const raw = await whoHoldsPort(port);
    const ourId = raw?.pid ? this.serviceHoldingPid(raw.pid) : null;
    const ourService = ourId ? config.services.find((s) => s.id === ourId) ?? null : null;

    // Never suggest a port another service already claims.
    const claimed = new Set<number>();
    for (const other of config.services) if (other.port) claimed.add(other.port);
    for (const managed of this.processes.values()) if (managed.activePort) claimed.add(managed.activePort);

    const cwd = resolveIn(config.root, service.cwd);
    const plan = planPortOverride(service, port, cwd);
    const suggestedPort = plan ? await findFreePort(port + 1, claimed) : null;

    return {
      serviceId: service.id,
      port,
      holder: {
        pid: raw?.pid ?? null,
        process: raw?.process ?? null,
        serviceId: ourId,
        serviceName: ourService?.name ?? null,
        likelyContainer: ourId === null && looksLikeContainer(raw),
      },
      suggestedPort,
      overrideMechanism: plan && suggestedPort ? planPortOverride(service, suggestedPort, cwd)?.mechanism ?? null : null,
      overrideCaveat: plan && suggestedPort ? planPortOverride(service, suggestedPort, cwd)?.caveat ?? null : null,
    };
  }

  /**
   * Attach to a service that is already running because someone started it elsewhere —
   * in a terminal, an IDE, or a console that has since exited.
   *
   * Adoption is only claimed on evidence: the process holding the service's port must
   * also be working in that service's directory, or name it on its command line.
   * Without that check any stranger on the port would be reported as the service, and
   * a later Stop would kill it.
   *
   * An adopted process can be stopped and restarted from here, but its output went
   * wherever it was started, so nothing before the adoption appears in the log pane.
   */
  async tryAdopt(service: ServiceConfig): Promise<boolean> {
    const port = service.port;
    if (!port) return false;

    const managed = this.managed(service);
    if (this.isAlive(managed)) return false;
    if (!(await isPortInUse(port))) return false;

    const holder = await whoHoldsPort(port);
    if (!holder?.pid) return false;
    if (this.serviceHoldingPid(holder.pid)) return false;

    const config = this.getConfig();
    const dir = resolveIn(config.root, service.cwd);
    const cwd = cwdOf(holder.pid);
    const cmdline = cmdlineOf(holder.pid) ?? "";
    const belongs = cwd === dir || cwd?.startsWith(`${dir}/`) === true || cmdline.includes(dir);
    if (!belongs) return false;

    managed.pid = holder.pid;
    managed.pgid = pgidOf(holder.pid) ?? holder.pid;
    managed.child = null;
    managed.adopted = true;
    managed.status = "running";
    managed.startedAt = startedAtOf(holder.pid) ?? Date.now();
    managed.activePort = port;
    managed.exitCode = null;
    managed.exitSignal = null;
    managed.stopping = false;
    if (managed.starts === 0) managed.starts = 1;

    this.log(
      service.id,
      "warn",
      `Adopted ${service.name}: already running on port ${port} as ${holder.process ?? "a process"} (pid ${holder.pid}), started outside this console.`,
    );
    this.log(service.id, "info", "It can be stopped and restarted from here. Output from before now went to wherever it was started.");
    this.persistState();
    return true;
  }

  /**
   * Wait for a port to be released after freeing whatever held it.
   *
   * A process exiting does not guarantee its listening socket is immediately
   * reusable, and starting into that gap produces an "address already in use" crash
   * that looks like the resolution simply did not work.
   */
  async waitForPortFree(port: number, serviceId: string, timeoutMs = 8000): Promise<boolean> {
    if (!(await isPortInUse(port))) return true;
    this.log(serviceId, "info", `Waiting for port ${port} to be released…`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      if (!(await isPortInUse(port))) return true;
    }
    this.log(serviceId, "error", `Port ${port} is still in use after ${timeoutMs / 1000}s.`);
    return false;
  }

  /** Spell the options out in the log pane too, so the terminal is never the only record. */
  private logResolutionHints(service: ServiceConfig, conflict: PortConflict): void {
    const { holder, suggestedPort } = conflict;
    if (holder.serviceId) {
      this.log(service.id, "warn", `That is "${holder.serviceName ?? holder.serviceId}", started from this console — stop it to free port ${conflict.port}.`);
    } else if (holder.likelyContainer) {
      this.log(service.id, "warn", `Port ${conflict.port} looks container-published; no process can be signalled. Stop the container (\`docker ps\`) or start on another port.`);
    } else if (holder.pid) {
      this.log(service.id, "warn", `Port ${conflict.port} is held by an outside process (${describeHolder(holder)}) — this console did not start it.`);
    }
    if (suggestedPort && conflict.overrideMechanism) {
      this.log(service.id, "info", `Port ${suggestedPort} is free — starting there would apply ${conflict.overrideMechanism}.`);
    }
  }

  /**
   * Terminate a process this console did not start, to free a port on explicit request.
   * Refuses anything that would take the console down with it.
   */
  async killForeignProcess(pid: number, serviceId: string): Promise<{ ok: boolean; message: string }> {
    if (pid <= 1 || pid === process.pid || pid === process.ppid) {
      const message = `Refusing to signal pid ${pid} — that is not a safe target.`;
      this.log(serviceId, "error", message);
      return { ok: false, message };
    }
    if (this.serviceHoldingPid(pid)) {
      const message = `pid ${pid} belongs to a service this console manages — stop that service instead.`;
      this.log(serviceId, "error", message);
      return { ok: false, message };
    }

    const group = pgidOf(pid);
    this.log(serviceId, "warn", `$ kill -TERM ${group ? `-${group}` : pid}   (freeing the port; this process was not started here)`);
    try {
      if (group) process.kill(-group, "SIGTERM");
      else process.kill(pid, "SIGTERM");
    } catch (error) {
      const message = `Could not signal pid ${pid}: ${error instanceof Error ? error.message : String(error)}`;
      this.log(serviceId, "error", message);
      return { ok: false, message };
    }

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(200);
      try {
        process.kill(pid, 0);
      } catch {
        this.log(serviceId, "info", `pid ${pid} exited.`);
        return { ok: true, message: `Stopped pid ${pid}.` };
      }
    }

    this.log(serviceId, "warn", `pid ${pid} ignored SIGTERM — sending SIGKILL.`);
    try {
      if (group) process.kill(-group, "SIGKILL");
      else process.kill(pid, "SIGKILL");
    } catch {
      // Gone between the check and the kill.
    }
    await sleep(500);
    return { ok: true, message: `Stopped pid ${pid}.` };
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

    // A spawned service settles its own status from the child's close event. An adopted
    // one has no child handle, so it is finalised here rather than waiting for a poll.
    if (managed.adopted && !this.isAlive(managed)) {
      managed.status = "stopped";
      managed.pid = null;
      managed.pgid = null;
      managed.activePort = null;
      managed.startedAt = null;
      managed.adopted = false;
      managed.stopping = false;
      this.log(service.id, "info", `${service.name} stopped.`);
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

  /**
   * Start every service in dependency order, waiting for each dependency to come up.
   *
   * The loop is cancellable: "Stop all" bumps the token, so a bulk start already in
   * flight stops issuing new starts instead of racing the shutdown it was asked to
   * yield to.
   */
  async startAll(ordered: ServiceConfig[]): Promise<ActionResult> {
    const token = ++this.bulkToken;
    const dependencies = new Set<string>();
    for (const service of ordered) for (const dep of service.dependsOn ?? []) dependencies.add(dep);

    let started = 0;
    let skipped = 0;
    let cancelled = false;

    for (const service of ordered) {
      if (token !== this.bulkToken || this.shuttingDown) {
        cancelled = true;
        break;
      }
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

    const message = cancelled
      ? `Start all cancelled: ${started} started before it was stopped.`
      : `Start all: ${started} started, ${skipped} skipped.`;
    this.logs.console(cancelled || started === 0 ? "warn" : "info", message);
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
    // Cancel any bulk start still walking the list, or it would keep starting
    // services behind us.
    this.bulkToken += 1;
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
    // Follow the port this run actually bound, which a resolved clash may have moved.
    const port = managed.activePort ?? service.port;
    if (!port || !service.healthPath) {
      managed.health = "n/a";
      return false;
    }
    // `localhost` rather than a literal address: Node tries both A and AAAA records,
    // which is what makes this work against IPv6-only listeners such as bare Vite.
    const url = `http://localhost:${port}${service.healthPath.startsWith("/") ? "" : "/"}${service.healthPath}`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        // A recognisable agent so request lines the service logs are traceable to us.
        headers: { accept: "*/*", "user-agent": "devdock-health-check" },
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
        let managed = this.processes.get(service.id);

        // Pick up anything already running that we did not start, so a service launched
        // in a terminal shows as running here instead of as stopped.
        if (!managed || !this.isAlive(managed)) {
          if (await this.tryAdopt(service)) managed = this.processes.get(service.id);
        }

        if (!managed) return;
        if (!this.isAlive(managed)) {
          if (managed.status === "running" || managed.status === "starting") {
            // An adopted process has no child handle, so no close event fires when it
            // goes; noticing it here is the only way its status ever settles.
            if (managed.adopted) {
              managed.status = managed.stopping ? "stopped" : "crashed";
              this.log(
                service.id,
                managed.stopping ? "info" : "warn",
                managed.stopping ? `${service.name} stopped.` : `${service.name} exited (it was started outside this console).`,
              );
              managed.pid = null;
              managed.pgid = null;
              managed.activePort = null;
              managed.startedAt = null;
              managed.adopted = false;
              managed.stopping = false;
              this.persistState();
            }
            managed.health = "unknown";
          }
          return;
        }
        if (!(managed.activePort ?? service.port) || !service.healthPath) {
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
