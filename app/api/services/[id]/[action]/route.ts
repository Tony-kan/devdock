import { buildSnapshot, findService, getCore } from "@/lib/server/core";
import { installDeps, pullService } from "@/lib/server/actions";
import type { ActionResult } from "@/lib/types";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["start", "stop", "restart", "pull", "install"]);

/** Per-service actions: start, stop, restart, pull, install. */
export async function POST(_request: Request, ctx: RouteContext<"/api/services/[id]/[action]">) {
  const { id, action } = await ctx.params;

  if (!ACTIONS.has(action)) {
    return Response.json({ ok: false, message: `Unknown action "${action}".` }, { status: 404 });
  }

  const service = findService(id);
  if (!service) {
    return Response.json({ ok: false, message: `No service with id "${id}".` }, { status: 404 });
  }

  const core = getCore();
  let result: ActionResult;
  try {
    switch (action) {
      case "start":
        result = await core.supervisor.start(service);
        break;
      case "stop":
        result = await core.supervisor.stop(service);
        break;
      case "restart":
        core.logs.append(service.id, "info", `Restarting ${service.name}…`);
        result = await core.supervisor.restart(service);
        break;
      case "pull":
        result = await pullService(service);
        break;
      default:
        result = await installDeps(service);
    }
  } catch (error) {
    const message = `${action} failed: ${error instanceof Error ? error.message : String(error)}`;
    core.logs.append(service.id, "error", message);
    result = { ok: false, message };
  }

  return Response.json({ ...result, snapshot: await buildSnapshot() });
}
