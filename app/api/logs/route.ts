import { getCore } from "@/lib/server/core";
import { ALL_SERVICES } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const service = params.get("service");
  const limit = Number(params.get("limit") ?? 1500);
  const core = getCore();
  const target = !service || service === ALL_SERVICES ? null : service;
  return Response.json({
    entries: core.logs.recent(target, Number.isFinite(limit) ? Math.min(limit, 3000) : 1500),
  });
}

export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  const service = params.get("service");
  const core = getCore();
  const target = !service || service === ALL_SERVICES ? null : service;
  core.logs.clear(target);
  core.logs.console("info", target ? `Cleared the log buffer for ${target}.` : "Cleared all log buffers.");
  return Response.json({ ok: true, message: "Log buffer cleared." });
}
