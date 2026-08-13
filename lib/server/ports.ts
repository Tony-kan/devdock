import net from "node:net";
import { execFile } from "node:child_process";

export interface PortHolder {
  pid: number | null;
  process: string | null;
}

/** True when something is already accepting connections on 127.0.0.1:port. */
export function isPortInUse(port: number, timeoutMs = 600): Promise<boolean> {
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
    socket.connect(port, "127.0.0.1");
  });
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

export function describeHolder(holder: PortHolder | null): string {
  if (!holder) return "an unidentified process";
  if (holder.pid && holder.process) return `${holder.process} (pid ${holder.pid})`;
  if (holder.pid) return `pid ${holder.pid}`;
  return "an unidentified process";
}
