import fs from "node:fs";
import net from "node:net";
import { execFile } from "node:child_process";

export interface PortHolder {
  pid: number | null;
  process: string | null;
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * True when something is already listening on the loopback port.
 *
 * Both address families are probed: Vite binds `[::1]` only when started without
 * `--host`, so an IPv4-only check would report a busy port as free and let a second
 * service start on top of it.
 */
export async function isPortInUse(port: number, timeoutMs = 600): Promise<boolean> {
  const results = await Promise.all([probe("127.0.0.1", port, timeoutMs), probe("::1", port, timeoutMs)]);
  return results.some(Boolean);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (_err, stdout) => resolve(stdout ?? ""));
  });
}

/**
 * Identify the process listening on a port. Uses `ss` first and falls back to
 * `lsof`; both report same-user processes without elevation, which covers every
 * process this console could have started.
 */
export async function whoHoldsPort(port: number): Promise<PortHolder | null> {
  const ss = await run("ss", ["-lptnH", `sport = :${port}`]);
  const ssMatch = ss.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (ssMatch) return { process: ssMatch[1], pid: Number(ssMatch[2]) };

  const lsof = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"]);
  const pid = lsof.match(/^p(\d+)/m);
  const name = lsof.match(/^c(.+)$/m);
  if (pid) return { pid: Number(pid[1]), process: name ? name[1] : null };

  // Something answered the socket probe but neither tool could name it.
  return ss.trim() || lsof.trim() ? { pid: null, process: null } : null;
}

/**
 * Process group of a pid, or null if it is gone.
 *
 * Services are spawned through a shell, so the process holding the port is usually a
 * grandchild of the console rather than the pid we recorded. The group id is what
 * ties it back to the service we started.
 */
export function pgidOf(pid: number): number | null {
  return statField(pid, 2);
}

/** Parent pid, or null if the process is gone. */
export function ppidOf(pid: number): number | null {
  return statField(pid, 1);
}

function statField(pid: number, index: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field can contain spaces and parentheses, so start after the last ')'.
    // Fields after that are: state(0) ppid(1) pgrp(2) …
    const value = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[index]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Working directory of a process, or null when it is gone or unreadable. */
export function cwdOf(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** Full command line of a process, space separated. */
export function cmdlineOf(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

/**
 * When a process started, in epoch milliseconds, read from its own kernel record.
 *
 * Adopted services did not start with us, so their uptime has to come from the system
 * rather than from the moment we noticed them — otherwise a service running since this
 * morning would report an uptime of seconds.
 */
export function startedAtOf(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 19 after the comm block is starttime, in clock ticks since boot.
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    if (!Number.isFinite(ticks)) return null;
    const uptimeSeconds = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (!Number.isFinite(uptimeSeconds)) return null;
    // USER_HZ is 100 on every Linux this runs on; /proc exposes no cheaper way to read it.
    const ageSeconds = uptimeSeconds - ticks / 100;
    return Date.now() - Math.max(0, ageSeconds) * 1000;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is a descendant of `ancestor`.
 *
 * Process groups are not enough to recognise our own services: `gradlew bootRun` forks
 * the application JVM into a group of its own, so a port held by a service this console
 * started looks like a stranger's. The parent chain still leads back to us.
 */
export function isDescendantOf(pid: number, ancestor: number, maxDepth = 24): boolean {
  let current: number | null = pid;
  for (let depth = 0; depth < maxDepth && current !== null && current > 1; depth += 1) {
    if (current === ancestor) return true;
    current = ppidOf(current);
  }
  return false;
}

/**
 * First free loopback port at or above `from`, skipping anything already claimed by
 * another configured service so we never hand out a port someone else expects.
 */
export async function findFreePort(from: number, avoid: Set<number> = new Set(), attempts = 200): Promise<number | null> {
  for (let port = from; port < Math.min(from + attempts, 65_535); port += 1) {
    if (avoid.has(port)) continue;
    if (!(await isPortInUse(port, 250))) return port;
  }
  return null;
}

/**
 * Docker publishes ports from a network namespace this process cannot inspect without
 * elevation, so the socket answers but no owning process is visible. Signalling is
 * impossible in that case; the container has to be stopped instead.
 */
export function looksLikeContainer(holder: PortHolder | null): boolean {
  if (!holder) return false;
  if (holder.pid === null) return true;
  return /docker|containerd|podman/i.test(holder.process ?? "");
}

export function describeHolder(holder: PortHolder | null): string {
  if (!holder) return "an unidentified process";
  if (holder.pid && holder.process) return `${holder.process} (pid ${holder.pid})`;
  if (holder.pid) return `pid ${holder.pid}`;
  return "an unidentified process";
}
