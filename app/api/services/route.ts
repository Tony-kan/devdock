import { buildSnapshot, getConfig, getCore, writeConfig } from "@/lib/server/core";
import { rescan } from "@/lib/server/config";
import type { ServiceConfig, ServiceKind } from "@/lib/types";

export const dynamic = "force-dynamic";

const KINDS: ServiceKind[] = ["Spring", "Node", "Docker", "Gradle", "Python", "Other"];

function slug(value: string): string {
  return value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export async function GET() {
  return Response.json(await buildSnapshot());
}

/** Add a service. Takes effect immediately — the console is never restarted for this. */
export async function POST(request: Request) {
  const core = getCore();
  const config = getConfig();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: "Request body was not valid JSON." }, { status: 400 });
  }

  if (body.rescan === true) {
    const { added } = rescan(config);
    const message =
      added.length > 0
        ? `Re-scan added ${added.length} service(s): ${added.map((s) => s.name).join(", ")}.`
        : "Re-scan found nothing new.";
    core.logs.console("info", message);
    return Response.json({ ok: true, message, snapshot: await buildSnapshot() });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!name || !command) {
    return Response.json({ ok: false, message: "A name and a command are both required." }, { status: 400 });
  }

  const portValue = Number(body.port);
  const kind = KINDS.includes(body.kind as ServiceKind) ? (body.kind as ServiceKind) : "Other";
  const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : ".";

  let id = slug(name) || "service";
  const taken = new Set(config.services.map((s) => s.id));
  let n = 2;
  while (taken.has(id)) id = `${slug(name)}-${n++}`;

  const service: ServiceConfig = {
    id,
    name,
    kind,
    cwd,
    command,
    port: Number.isFinite(portValue) && portValue > 0 ? portValue : null,
    env: {},
    healthPath: typeof body.healthPath === "string" && body.healthPath.trim() ? body.healthPath.trim() : null,
    dependsOn: [],
    autoStart: false,
    repo: cwd,
    url: null,
  };

  writeConfig({ ...config, services: [...config.services, service] });
  const message = `Added service "${name}" (${command}).`;
  core.logs.console("info", message);
  return Response.json({ ok: true, message, snapshot: await buildSnapshot() });
}

/** Reorder the service list. Body: `{ ids: string[] }`. */
export async function PUT(request: Request) {
  const config = getConfig();
  let body: { ids?: unknown };
  try {
    body = (await request.json()) as { ids?: unknown };
  } catch {
    return Response.json({ ok: false, message: "Request body was not valid JSON." }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  const byId = new Map(config.services.map((s) => [s.id, s]));
  const ordered: ServiceConfig[] = [];
  for (const id of ids) {
    const service = byId.get(id);
    if (service) {
      ordered.push(service);
      byId.delete(id);
    }
  }
  // Anything the client did not mention keeps its relative position at the end.
  ordered.push(...byId.values());

  writeConfig({ ...config, services: ordered });
  return Response.json({ ok: true, message: "Order saved.", snapshot: await buildSnapshot() });
}
