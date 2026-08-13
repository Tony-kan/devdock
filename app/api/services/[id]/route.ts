import { buildSnapshot, findService, getConfig, getCore, writeConfig } from "@/lib/server/core";
import type { ServiceConfig, ServiceKind } from "@/lib/types";

export const dynamic = "force-dynamic";

const KINDS: ServiceKind[] = ["Spring", "Node", "Docker", "Gradle", "Python", "Other"];

/** Edit a service in place: command, port, env, health path, dependencies, autoStart. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/services/[id]">) {
  const { id } = await ctx.params;
  const service = findService(id);
  if (!service) return Response.json({ ok: false, message: `No service with id "${id}".` }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: "Request body was not valid JSON." }, { status: 400 });
  }

  const next: ServiceConfig = { ...service };
  if (typeof body.name === "string" && body.name.trim()) next.name = body.name.trim();
  if (typeof body.command === "string" && body.command.trim()) next.command = body.command.trim();
  if (typeof body.cwd === "string" && body.cwd.trim()) next.cwd = body.cwd.trim();
  if (typeof body.repo === "string") next.repo = body.repo.trim() || next.cwd;
  if (KINDS.includes(body.kind as ServiceKind)) next.kind = body.kind as ServiceKind;
  if ("port" in body) {
    const port = Number(body.port);
    next.port = Number.isFinite(port) && port > 0 ? port : null;
  }
  if ("healthPath" in body) {
    next.healthPath = typeof body.healthPath === "string" && body.healthPath.trim() ? body.healthPath.trim() : null;
  }
  if ("url" in body) {
    next.url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : null;
  }
  if ("autoStart" in body) next.autoStart = body.autoStart === true;
  if (Array.isArray(body.dependsOn)) {
    next.dependsOn = body.dependsOn.filter((d): d is string => typeof d === "string");
  }
  if (body.env && typeof body.env === "object") {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
      if (key.trim()) env[key.trim()] = String(value ?? "");
    }
    next.env = env;
  }

  const config = getConfig();
  writeConfig({ ...config, services: config.services.map((s) => (s.id === id ? next : s)) });

  const core = getCore();
  core.logs.append(id, "info", `Configuration updated for ${next.name}.`);
  if (next.command !== service.command) {
    core.logs.append(id, "warn", "The command changed — restart the service for it to take effect.");
  }
  if (JSON.stringify(next.env) !== JSON.stringify(service.env)) {
    core.logs.append(id, "warn", "Environment variables changed — restart the service for them to take effect.");
  }

  return Response.json({ ok: true, message: `Saved ${next.name}.`, snapshot: await buildSnapshot() });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/services/[id]">) {
  const { id } = await ctx.params;
  const service = findService(id);
  if (!service) return Response.json({ ok: false, message: `No service with id "${id}".` }, { status: 404 });

  const core = getCore();
  const config = getConfig();

  // Dropping a service must not leave its process running unattended.
  core.supervisor.forget(id);
  writeConfig({
    ...config,
    services: config.services
      .filter((s) => s.id !== id)
      .map((s) => ({ ...s, dependsOn: (s.dependsOn ?? []).filter((dep) => dep !== id) })),
  });

  const message = `Removed "${service.name}".`;
  core.logs.console("info", message);
  return Response.json({ ok: true, message, snapshot: await buildSnapshot() });
}
