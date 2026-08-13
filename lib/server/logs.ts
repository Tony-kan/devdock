import fs from "node:fs";
import path from "node:path";
import { LOG_DIR, logFileFor } from "./paths";
import { CONSOLE_LOG_SERVICE, type LogEntry, type LogLevel } from "../types";

const RING_LIMIT = 3000;
const ROTATE_BYTES = 5 * 1024 * 1024;

type Subscriber = (entry: LogEntry) => void;

/**
 * Per-service ring buffers plus append-only files under `.logs/`.
 *
 * A single monotonic sequence number is shared across services so the combined
 * view can interleave them in true arrival order without relying on timestamps
 * (several lines routinely land inside the same millisecond).
 */
export class LogStore {
  private rings = new Map<string, LogEntry[]>();
  private streams = new Map<string, fs.WriteStream>();
  private subscribers = new Set<Subscriber>();
  private seq = 0;

  append(service: string, level: LogLevel, text: string): LogEntry {
    const entry: LogEntry = { seq: ++this.seq, ts: Date.now(), service, level, text };

    let ring = this.rings.get(service);
    if (!ring) {
      ring = [];
      this.rings.set(service, ring);
    }
    ring.push(entry);
    if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);

    this.persist(entry);
    for (const fn of this.subscribers) {
      try {
        fn(entry);
      } catch {
        // A broken subscriber must never take down log capture.
      }
    }
    return entry;
  }

  /** Split a chunk of process output into lines and classify each one. */
  appendOutput(service: string, chunk: string, stream: "stdout" | "stderr"): void {
    for (const raw of chunk.split(/\r?\n/)) {
      const line = stripAnsi(raw).replace(/\s+$/, "");
      if (line === "") continue;
      this.append(service, classify(line, stream), line);
    }
  }

  console(level: LogLevel, text: string): LogEntry {
    return this.append(CONSOLE_LOG_SERVICE, level, text);
  }

  /** Most recent entries for one service, or the interleaved combined view. */
  recent(service: string | null, limit = RING_LIMIT): LogEntry[] {
    if (service) return (this.rings.get(service) ?? []).slice(-limit);
    const merged: LogEntry[] = [];
    for (const ring of this.rings.values()) merged.push(...ring);
    merged.sort((a, b) => a.seq - b.seq);
    return merged.slice(-limit);
  }

  clear(service: string | null): void {
    if (service) this.rings.delete(service);
    else this.rings.clear();
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  closeAll(): void {
    for (const stream of this.streams.values()) stream.end();
    this.streams.clear();
  }

  private persist(entry: LogEntry): void {
    try {
      const stream = this.streamFor(entry.service);
      stream.write(`${new Date(entry.ts).toISOString()} ${entry.level.toUpperCase()} ${entry.text}\n`);
    } catch {
      // Disk trouble must not stop the live stream; the UI is the primary surface.
    }
  }

  private streamFor(service: string): fs.WriteStream {
    const existing = this.streams.get(service);
    if (existing) return existing;

    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = logFileFor(service);
    try {
      const stat = fs.statSync(file);
      if (stat.size > ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // No existing file — nothing to rotate.
    }
    const stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", () => this.streams.delete(service));
    this.streams.set(service, stream);
    return stream;
  }
}

/**
 * Remove ANSI colour and cursor sequences. `NO_COLOR` covers most tools, but Gradle
 * and Docker Compose still emit control codes that would otherwise reach the pane.
 */
const ANSI_PATTERN = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><]",
  "g",
);
const CONTROL_PATTERN = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

/**
 * Best-effort level detection over heterogeneous output (Spring, Gradle, Vite, Docker).
 *
 * stderr defaults to `warn` rather than `error`: Gradle, Vite and Docker Compose all
 * write ordinary progress to stderr, so treating the stream as the level would paint
 * a healthy startup red.
 */
export function classify(line: string, stream: "stdout" | "stderr"): LogLevel {
  if (/\b(ERROR|SEVERE|FATAL)\b/.test(line)) return "error";
  if (/\b[\w.$]*(Exception|Error)\b\s*[:(]/.test(line)) return "error";
  if (/^\s+at\s[\w$.<>/]+\(/.test(line)) return "error";
  if (/\b(BUILD FAILED|FAILURE:|Caused by:|panic:)/.test(line)) return "error";
  if (/\bWARN(ING)?\b/.test(line)) return "warn";
  if (/\bdeprecated\b/i.test(line)) return "warn";
  if (stream === "stderr") return "warn";
  return "info";
}

/** Turn a log file path into something safe to show in the UI. */
export function logFileLabel(service: string): string {
  return path.relative(process.cwd(), logFileFor(service));
}
