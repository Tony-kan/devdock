import fs from "node:fs";
import { getConfig, getCore, invalidateGit, markPulled, repoForService, repoPaths } from "./core";
import { resolveIn } from "./paths";
import { run } from "./exec";
import { gitPull, installCommandFor } from "./git";
import { startOrder } from "./config";
import type { ActionResult, ServiceConfig } from "../types";

/** Pull the repository a single service lives in. */
export async function pullService(service: ServiceConfig): Promise<ActionResult> {
  const core = getCore();
  const config = getConfig();
  const rel = repoForService(service);
  const dir = resolveIn(config.root, rel);

  if (!fs.existsSync(dir)) {
    const message = `Cannot pull: ${dir} does not exist.`;
    core.logs.append(service.id, "error", message);
    return { ok: false, message };
  }

  core.supervisor.setBusy(service.id, "pulling");
  try {
    const outcome = await gitPull(dir, rel, (level, text) => core.logs.append(service.id, level, text));
    invalidateGit(rel);
    if (outcome.ok) markPulled();
    return { ok: outcome.ok, message: outcome.message, needsInstall: outcome.needsInstall, conflicts: outcome.conflicts };
  } finally {
    core.supervisor.setBusy(service.id, null);
  }
}

/** Pull every repository referenced by the configured services, one at a time. */
export async function pullAll(): Promise<ActionResult> {
  const core = getCore();
  const config = getConfig();
  const repos = repoPaths(config);
  core.logs.console("info", `Pulling ${repos.length} repositories.`);

  let pulled = 0;
  let failed = 0;
  let conflicted = 0;
  const needsInstall: string[] = [];

  for (const rel of repos) {
    const dir = resolveIn(config.root, rel);
    if (!fs.existsSync(dir)) {
      core.logs.console("warn", `Skipping ${rel} — directory is missing.`);
      failed += 1;
      continue;
    }
    const outcome = await gitPull(dir, rel, (level, text) => core.logs.console(level, text));
    invalidateGit(rel);
    if (outcome.conflicts) conflicted += 1;
    else if (outcome.ok) pulled += 1;
    else failed += 1;
    if (outcome.needsInstall) needsInstall.push(rel);
  }

  markPulled();

  const parts = [`${pulled} pulled`];
  if (conflicted) parts.push(`${conflicted} with conflicts`);
  if (failed) parts.push(`${failed} failed`);
  const message = `Pull latest: ${parts.join(", ")}.`;
  core.logs.console(conflicted || failed ? "warn" : "info", message);

  if (needsInstall.length > 0) {
    core.logs.console("warn", `Dependency files changed in: ${needsInstall.join(", ")} — run "Install deps" on those services.`);
  }

  return { ok: failed === 0 && conflicted === 0, message, needsInstall: needsInstall.length > 0, conflicts: conflicted > 0 };
}

/** Run the ecosystem's dependency install for one service. */
export async function installDeps(service: ServiceConfig): Promise<ActionResult> {
  const core = getCore();
  const config = getConfig();
  const command = installCommandFor(service);
  if (!command) {
    const message = `No install command is known for a ${service.kind} service.`;
    core.logs.append(service.id, "warn", message);
    return { ok: false, message };
  }

  const dir = resolveIn(config.root, service.cwd);
  core.supervisor.setBusy(service.id, "installing");
  core.logs.append(service.id, "info", `$ ${command}`);
  try {
    const result = await run(command, null, {
      cwd: dir,
      env: { NO_COLOR: "1", FORCE_COLOR: "0", ...service.env },
      sink: (level, text) => core.logs.append(service.id, level, text),
      timeoutMs: 15 * 60_000,
    });

    if (result.spawnError) {
      const message = `Install failed to start: ${result.spawnError}`;
      core.logs.append(service.id, "error", message);
      return { ok: false, message };
    }
    if (result.code !== 0) {
      const message = `Install failed with exit code ${result.code}.`;
      core.logs.append(service.id, "error", message);
      return { ok: false, message };
    }
    const message = `Dependencies installed for ${service.name}.`;
    core.logs.append(service.id, "info", message);
    return { ok: true, message };
  } finally {
    core.supervisor.setBusy(service.id, null);
  }
}

export async function startAll(): Promise<ActionResult> {
  const core = getCore();
  const config = getConfig();
  core.logs.console("info", "Start all requested.");
  return core.supervisor.startAll(startOrder(config.services));
}

export async function stopAll(): Promise<ActionResult> {
  const core = getCore();
  const config = getConfig();
  core.logs.console("info", "Stop all requested.");
  return core.supervisor.stopAll(startOrder(config.services));
}
