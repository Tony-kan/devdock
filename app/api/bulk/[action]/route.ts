import { buildSnapshot, getCore } from "@/lib/server/core";
import { pullAll, startAll, stopAll } from "@/lib/server/actions";
import type { ActionResult } from "@/lib/types";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["start-all", "stop-all", "pull-all"]);

/** Repo-wide actions: start all (in dependency order), stop all, pull every repo. */
export async function POST(_request: Request, ctx: RouteContext<"/api/bulk/[action]">) {
  const { action } = await ctx.params;
  if (!ACTIONS.has(action)) {
    return Response.json({ ok: false, message: `Unknown action "${action}".` }, { status: 404 });
  }

  const core = getCore();
  let result: ActionResult;
  try {
    if (action === "start-all") result = await startAll();
    else if (action === "stop-all") result = await stopAll();
    else result = await pullAll();
  } catch (error) {
    const message = `${action} failed: ${error instanceof Error ? error.message : String(error)}`;
    core.logs.console("error", message);
    result = { ok: false, message };
  }

  return Response.json({ ...result, snapshot: await buildSnapshot({ forceGit: action === "pull-all" }) });
}
