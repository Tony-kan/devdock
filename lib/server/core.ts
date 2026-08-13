import { LogStore } from "./logs";
import { Supervisor } from "./supervisor";
import { loadConfig, saveConfig, startOrder } from "./config";
import { gitInfo } from "./git";
import { CONFIG_PATH, LOG_DIR, relativeToRoot, resolveIn } from "./paths";
import type { ConsoleConfig, GitInfo, ServiceConfig, Snapshot } from "../types";

const GIT_TTL_MS = 15_000;

interface Core {
  logs: LogStore;
  supervisor: Supervisor;
  gitCache: Map<string, GitInfo>;
  lastPullAt: number | null;
  bootedAt: number;
}

/**
 * Next.js re-executes route modules on every edit in dev, so the supervisor has to
 * live somewhere module reloading cannot reach. `globalThis` is the pattern Next
 * prescribes for exactly this (it is how database pools survive HMR), and it was
 * verified here: child PIDs and counters survive an edit to a route file.
 */
const globalRef = globalThis as unknown as { __devdockCore?: Core };

function boot(): Core {
  const logs = new LogStore();
  const core: Core = {
    logs,
    supervisor: new Supervisor(logs, () => loadConfig().config),
    gitCache: new Map(),
    lastPullAt: null,
    bootedAt: Date.now(),
  };

  const { config, generated, generatedCount } = loadConfig();
  logs.console("info", `Devdock console started. Workspace: ${config.root}`);
  if (generated) {
    logs.console("info", `Generated ${CONFIG_PATH} with ${generatedCount} services discovered by scanning the workspace.`);
  } else {
    logs.console("info", `Loaded ${config.services.length} services from ${CONFIG_PATH}`);
  }
  logs.console("info", `Logs are written to ${LOG_DIR}/<service>.log`);

  core.supervisor.init();

  // Clean up children on every exit path so nothing is orphaned.
  const shutdown = (signal: string) => {
    logs.console("warn", `Received ${signal} — stopping all managed processes.`);
    core.supervisor.terminateAll();
    setTimeout(() => core.supervisor.killAllSync(), 2000).unref?.();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGHUP", () => shutdown("SIGHUP"));
  process.on("exit", () => {
    core.supervisor.killAllSync();
    logs.closeAll();
  });

  void autoStart(core, config);
  return core;
}

async function autoStart(core: Core, config: ConsoleConfig): Promise<void> {
  const wanted = config.services.filter((s) => s.autoStart).map((s) => s.id);
  if (wanted.length === 0) return;
  core.logs.console("info", `Auto-starting ${wanted.length} service(s) marked autoStart.`);
  await core.supervisor.startAll(startOrder(config.services, wanted));
}

export function getCore(): Core {
  if (!globalRef.__devdockCore) globalRef.__devdockCore = boot();
  return globalRef.__devdockCore;
}

export function getConfig(): ConsoleConfig {
  return loadConfig().config;
}

export function writeConfig(config: ConsoleConfig): ConsoleConfig {
  return saveConfig(config);
}

export function findService(id: string): ServiceConfig | null {
  return getConfig().services.find((s) => s.id === id) ?? null;
}

/** Every distinct git repository referenced by the configured services. */
export function repoPaths(config: ConsoleConfig): string[] {
  const repos = new Set<string>();
  for (const service of config.services) repos.add(service.repo || service.cwd || ".");
  return [...repos].sort();
}

export function repoForService(service: ServiceConfig): string {
  return service.repo || service.cwd || ".";
}

/** Cached git status per repo. `force` bypasses the TTL, e.g. right after a pull. */
export async function gitStatusFor(config: ConsoleConfig, repos: string[], force = false): Promise<Record<string, GitInfo>> {
  const core = getCore();
  const now = Date.now();
  const out: Record<string, GitInfo> = {};

  await Promise.allSettled(
    repos.map(async (rel) => {
      const cached = core.gitCache.get(rel);
      if (!force && cached && now - cached.checkedAt < GIT_TTL_MS) {
        out[rel] = cached;
        return;
      }
      const dir = resolveIn(config.root, rel);
      const info = await gitInfo(dir, relativeToRoot(config.root, dir));
      core.gitCache.set(rel, { ...info, repo: rel });
      out[rel] = core.gitCache.get(rel)!;
    }),
  );

  return out;
}

export function invalidateGit(rel?: string): void {
  const core = getCore();
  if (rel) core.gitCache.delete(rel);
  else core.gitCache.clear();
}

export function markPulled(): void {
  getCore().lastPullAt = Date.now();
}

export async function buildSnapshot(options: { forceGit?: boolean } = {}): Promise<Snapshot> {
  const core = getCore();
  const config = getConfig();
  const repos = repoPaths(config);
  const git = await gitStatusFor(config, repos, options.forceGit);

  const runtime = Object.fromEntries(config.services.map((s) => [s.id, core.supervisor.runtimeFor(s)]));
  const running = Object.values(runtime).filter((r) => r.status === "running" || r.status === "starting").length;
  const errors = Object.values(runtime).filter((r) => r.status === "crashed" || r.health === "fail").length;
  const repoInfos = Object.values(git).filter((info) => info.isRepo);

  return {
    root: config.root,
    services: config.services,
    runtime,
    git,
    counts: {
      running,
      total: config.services.length,
      errors,
      repos: repoInfos.length,
      dirtyRepos: repoInfos.filter((info) => info.dirty > 0).length,
      behindRepos: repoInfos.filter((info) => info.behind > 0).length,
    },
    lastPullAt: core.lastPullAt,
    configPath: CONFIG_PATH,
    logDir: LOG_DIR,
  };
}
