import { spawn } from "node:child_process";
import type { LogLevel } from "../types";

/**
 * Variables the console's own runtime injects, which describe the console rather than
 * whatever we are about to run. Left in place they actively mislead a child: `PORT` is
 * the console's listen port, so a service that honours it (Express, Next, Rails…) would
 * try to bind the console's port and fail with a confusing "address in use", and an
 * inherited `NODE_ENV=production` would put a dev server into production mode and make
 * `npm install` skip devDependencies.
 *
 * Explicit per-service env is applied after this, so any of them can still be set.
 */
const CONSOLE_ONLY_ENV = ["PORT", "NODE_ENV", "HOSTNAME", "NEXT_RUNTIME", "NEXT_DEPLOYMENT_ID"];

export function childEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CONSOLE_ONLY_ENV.includes(key)) continue;
    if (key.startsWith("__NEXT_") || key.startsWith("NEXT_PRIVATE")) continue;
    env[key] = value;
  }
  // `ProcessEnv` declares NODE_ENV as always present, and dropping it is the point
  // here — the child must fall back to its own tool's default, not inherit ours.
  return { ...env, ...overrides } as NodeJS.ProcessEnv;
}

export type LineSink = (level: LogLevel, text: string) => void;

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be spawned at all. */
  spawnError: string | null;
}

interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** When set, every output line is forwarded here as it arrives. */
  sink?: LineSink;
  /** Level used for stdout lines when a sink is attached. */
  level?: LogLevel;
}

/**
 * Run a one-shot command to completion, optionally streaming its output into the
 * log pane as it arrives. `args === null` means the command is a shell string.
 */
export function run(command: string, args: string[] | null, options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = args
      ? spawn(command, args, { cwd: options.cwd, env: childEnvironment(options.env) })
      : spawn(command, { cwd: options.cwd, env: childEnvironment(options.env), shell: true });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }, options.timeoutMs)
      : null;

    const forward = (chunk: string, stream: "stdout" | "stderr") => {
      if (!options.sink) return;
      for (const raw of chunk.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, "");
        if (line === "") continue;
        options.sink(stream === "stderr" ? "warn" : options.level ?? "info", line);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      forward(chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      forward(chunk, "stderr");
    });

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (error) => {
      finish({ code: null, signal: null, stdout, stderr, spawnError: error.message });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, stdout, stderr, spawnError: null });
    });
  });
}

/** Convenience wrapper for short commands whose output we only want as a string. */
export async function capture(command: string, args: string[], cwd: string, timeoutMs = 10_000): Promise<RunResult> {
  return run(command, args, { cwd, timeoutMs });
}
