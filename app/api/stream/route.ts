import { buildSnapshot, getCore } from "@/lib/server/core";
import type { LogEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

const LOG_FLUSH_MS = 120;
const STATE_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 15_000;
const MAX_BATCH = 400;

/**
 * Server-sent events carrying log lines and runtime state.
 *
 * SSE rather than a WebSocket: it needs no extra dependency and runs inside a plain
 * Route Handler, which keeps the console at zero packages beyond what the repo had.
 */
export async function GET(request: Request) {
  const core = getCore();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let pending: LogEntry[] = [];

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const flushLogs = () => {
        if (closed || pending.length === 0) return;
        const batch = pending.slice(-MAX_BATCH);
        const dropped = pending.length - batch.length;
        pending = [];
        send("log", { entries: batch, dropped });
      };

      const unsubscribe = core.logs.subscribe((entry) => {
        pending.push(entry);
      });

      const logTimer = setInterval(flushLogs, LOG_FLUSH_MS);
      const stateTimer = setInterval(async () => {
        if (closed) return;
        try {
          send("state", await buildSnapshot());
        } catch (error) {
          // Not named "error": EventSource delivers its own transport failures
          // under that name, and the two must stay distinguishable in the client.
          send("server-error", { message: error instanceof Error ? error.message : String(error) });
        }
      }, STATE_INTERVAL_MS);
      const heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(logTimer);
        clearInterval(stateTimer);
        clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      };

      request.signal.addEventListener("abort", teardown);

      send("hello", { snapshot: await buildSnapshot(), entries: core.logs.recent(null, 1500) });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disables proxy buffering, which would otherwise hold lines back.
      "x-accel-buffering": "no",
    },
  });
}
