import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, defaultRoot } from "./paths";
import { discoverServices } from "./discover";
import type { ConsoleConfig, ServiceConfig, ServiceKind } from "../types";

const KINDS: ServiceKind[] = ["Spring", "Node", "Docker", "Gradle", "Python", "Other"];

interface LoadResult {
  config: ConsoleConfig;
  /** True when this call created services.json by scanning the workspace. */
  generated: boolean;
  generatedCount: number;
}

let cache: { mtimeMs: number; config: ConsoleConfig } | null = null;

function normalize(raw: unknown, index: number): ServiceConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  if (!name || !command) return null;

  const id =
    typeof entry.id === "string" && entry.id.trim()
      ? entry.id.trim()
      : `${name.toLowerCase().replace(/[^\w.-]+/g, "-")}-${index}`;

  const kind = KINDS.includes(entry.kind as ServiceKind) ? (entry.kind as ServiceKind) : "Other";
  const cwd = typeof entry.cwd === "string" && entry.cwd.trim() ? entry.cwd.trim() : ".";
  const portValue = Number(entry.port);
  const env: Record<string, string> = {};
  if (entry.env && typeof entry.env === "object") {
    for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof key === "string" && key.trim()) env[key.trim()] = String(value ?? "");
    }
  }

  return {
    id,
    name,
    kind,
    cwd,
    command,
    port: Number.isFinite(portValue) && portValue > 0 ? portValue : null,
    env,
    healthPath: typeof entry.healthPath === "string" && entry.healthPath.trim() ? entry.healthPath.trim() : null,
    dependsOn: Array.isArray(entry.dependsOn) ? entry.dependsOn.filter((d): d is string => typeof d === "string") : [],
    autoStart: entry.autoStart === true,
    repo: typeof entry.repo === "string" && entry.repo.trim() ? entry.repo.trim() : cwd,
    url: typeof entry.url === "string" && entry.url.trim() ? entry.url.trim() : null,
  };
}

function parse(body: string): ConsoleConfig {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const root = typeof raw.root === "string" && raw.root.trim() ? path.resolve(raw.root.trim()) : defaultRoot();
  const list = Array.isArray(raw.services) ? raw.services : [];
  const services: ServiceConfig[] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const service = normalize(entry, index);
    if (!service || seen.has(service.id)) return;
    seen.add(service.id);
    services.push(service);
  });
  return { root, services };
}

/**
 * Read services.json, generating it from a workspace scan on first run.
 *
 * The file is re-read whenever its mtime changes, so editing it by hand — or from
 * another process — takes effect on the next request without restarting the console.
 */
export function loadConfig(): LoadResult {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(CONFIG_PATH);
  } catch {
    stat = null;
  }

  if (!stat) {
    const root = defaultRoot();
    const services = discoverServices(root);
    const config: ConsoleConfig = { root, services };
    saveConfig(config);
    return { config, generated: true, generatedCount: services.length };
  }

  if (cache && cache.mtimeMs === stat.mtimeMs) {
    return { config: cache.config, generated: false, generatedCount: 0 };
  }

  const config = parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  cache = { mtimeMs: stat.mtimeMs, config };
  return { config, generated: false, generatedCount: 0 };
}

export function saveConfig(config: ConsoleConfig): ConsoleConfig {
  const body = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(CONFIG_PATH, body, "utf8");
  try {
    const stat = fs.statSync(CONFIG_PATH);
    cache = { mtimeMs: stat.mtimeMs, config };
  } catch {
    cache = null;
  }
  return config;
}

/** Re-scan the workspace and append anything not already configured. */
export function rescan(config: ConsoleConfig): { added: ServiceConfig[]; config: ConsoleConfig } {
  const known = new Set(config.services.map((s) => `${s.cwd}::${s.command}`));
  const added = discoverServices(config.root).filter((s) => !known.has(`${s.cwd}::${s.command}`));
  if (added.length === 0) return { added, config };

  const ids = new Set(config.services.map((s) => s.id));
  const deduped = added.map((service) => {
    let id = service.id;
    let n = 2;
    while (ids.has(id)) id = `${service.id}-${n++}`;
    ids.add(id);
    return { ...service, id };
  });

  return { added: deduped, config: saveConfig({ ...config, services: [...config.services, ...deduped] }) };
}

/**
 * Order services so every dependency starts before the things that need it.
 * Cycles are broken by falling back to the configured order rather than throwing —
 * a bad `dependsOn` should not make "start all" unusable.
 */
export function startOrder(services: ServiceConfig[], subset?: string[]): ServiceConfig[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const wanted = subset ? subset.filter((id) => byId.has(id)) : services.map((s) => s.id);
  const ordered: ServiceConfig[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const visit = (id: string) => {
    if (placed.has(id) || visiting.has(id)) return;
    const service = byId.get(id);
    if (!service) return;
    visiting.add(id);
    for (const dep of service.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    placed.add(id);
    ordered.push(service);
  };

  for (const id of wanted) visit(id);
  return ordered;
}
