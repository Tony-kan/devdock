import { spawn } from "node:child_process";
import type { LogLevel } from "../types";

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
      ? spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env } })
      : spawn(command, { cwd: options.cwd, env: { ...process.env, ...options.env }, shell: true });

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
