import fs from "node:fs";
import path from "node:path";
import { getConfig, getCore, invalidateGit, markPulled, repoForService, repoPaths, writeConfig } from "./core";
import { resolveIn } from "./paths";
import { run } from "./exec";
import { gitPull, installCommandFor } from "./git";
import { planPortOverride } from "./portOverride";
import { serviceEnv, startOrder } from "./config";
import type { ActionResult, ConflictResolution, ServiceConfig } from "../types";

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
  let skipped = 0;
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
    else if (outcome.skipped) skipped += 1;
    else if (outcome.ok) pulled += 1;
    else failed += 1;
    if (outcome.needsInstall) needsInstall.push(rel);
  }

  markPulled();

  const parts = [`${pulled} pulled`];
  if (skipped) parts.push(`${skipped} not repositories`);
  if (conflicted) parts.push(`${conflicted} with conflicts`);
  if (failed) parts.push(`${failed} failed`);
  const message = `Pull latest: ${parts.join(", ")}.`;
  core.logs.console(conflicted || failed ? "warn" : "info", message);

  if (needsInstall.length > 0) {
    core.logs.console("warn", `Dependency files changed in: ${needsInstall.join(", ")} — run "Install deps" on those services.`);
  }

  return { ok: failed === 0 && conflicted === 0, message, needsInstall: needsInstall.length > 0, conflicts: conflicted > 0 };
}

/**
 * Where to run the install. A Node service run from inside an npm workspace
 * (`packages/website`, say) installs from the repository root: the lockfile and the
 * `node_modules` every package resolves from both live there.
 */
function installDirFor(service: ServiceConfig, root: string): string {
  const cwd = resolveIn(root, service.cwd);
  if (service.kind !== "Node") return cwd;
  const repo = resolveIn(root, repoForService(service));
  return repo !== cwd && fs.existsSync(path.join(repo, "package.json")) ? repo : cwd;
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

  const dir = installDirFor(service, config.root);
  core.supervisor.setBusy(service.id, "installing");
  core.logs.append(service.id, "info", `$ ${command}   (in ${dir})`);
  try {
    const result = await run(command, null, {
      cwd: dir,
      env: { NO_COLOR: "1", FORCE_COLOR: "0", ...serviceEnv(config, service) },
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

export interface StartRequest {
  /** How the user chose to clear the port. Absent means a plain start. */
  resolve?: ConflictResolution;
  /** Target port for "use-port". */
  port?: number;
  /** Write the new port into services.json as well as using it for this run. */
  persist?: boolean;
}

/**
 * Start a service, optionally clearing a port clash first.
 *
 * Every route through here is explicit: nothing reassigns a port, stops another
 * service or signals a foreign process unless the request asked for it. A moved port
 * is only written to services.json when `persist` is set, because other services
 * reference each other by port and a silent change breaks them invisibly.
 */
export async function startService(service: ServiceConfig, request: StartRequest = {}): Promise<ActionResult> {
  const core = getCore();

  if (!request.resolve) {
    const pending = core.supervisor.pendingDependencies(service);
    if (pending.length === 0) return core.supervisor.start(service);

    // Bringing up a database and a backend first can take minutes, far longer than a
    // request should hang. The chain runs in the background and reports in the log
    // pane; a port clash on the service itself is logged there too, with the same
    // ways out the conflict panel would have offered.
    const names = pending.map((s) => s.name).join(", ");
    core.logs.append(service.id, "info", `Starting ${pending.length} dependenc${pending.length === 1 ? "y" : "ies"} first: ${names}.`);
    core.supervisor.setBusy(service.id, "starting dependencies");
    void core.supervisor
      .startWithDependencies(service)
      .catch((error: unknown) => {
        core.logs.append(service.id, "error", `Start failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => core.supervisor.setBusy(service.id, null));
    return { ok: true, message: `Starting ${service.name} after ${names}…` };
  }

  if (request.resolve === "use-port") {
    const port = Number(request.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ok: false, message: `"${request.port}" is not a valid port.` };
    }

    const config = getConfig();
    const clash = config.services.find((other) => other.id !== service.id && other.port === port);
    if (clash) {
      const message = `Port ${port} is already assigned to "${clash.name}" in the configuration. Pick another.`;
      core.logs.append(service.id, "error", message);
      return { ok: false, message };
    }

    let target = service;
    if (request.persist) {
      // Saving the port alone is not enough: the move is carried by an env var (or a
      // rewritten command), and leaving the old one behind would make the saved config
      // contradict itself — the next plain start would bind the port it used to use.
      const plan = planPortOverride(service, port, resolveIn(config.root, service.cwd));
      target = {
        ...service,
        port,
        env: { ...service.env, ...(plan?.env ?? {}) },
        command: plan?.command ?? service.command,
      };
      writeConfig({ ...config, services: config.services.map((s) => (s.id === service.id ? target : s)) });
      core.logs.append(service.id, "warn", `Saved port ${port} to services.json (was ${service.port ?? "unset"}).`);
      if (plan) core.logs.append(service.id, "info", `Saved the port mechanism too: ${plan.mechanism}`);
      core.logs.append(
        service.id,
        "warn",
        "Anything that calls this service by port still points at the old one — update those settings too.",
      );
    }
    return core.supervisor.start(target, { portOverride: port });
  }

  const port = service.port;
  if (!port) return core.supervisor.start(service);

  const conflict = await core.supervisor.describeConflict(service, port);

  if (request.resolve === "stop-holder") {
    const holderId = conflict.holder.serviceId;
    const holder = holderId ? getConfig().services.find((s) => s.id === holderId) ?? null : null;
    if (!holder) {
      const message = `Port ${port} is no longer held by a service this console manages — nothing was stopped.`;
      core.logs.append(service.id, "warn", message);
      return { ok: false, message, conflict };
    }
    core.logs.append(service.id, "info", `Stopping "${holder.name}" to free port ${port}.`);
    await core.supervisor.stop(holder);
    if (!(await core.supervisor.waitForPortFree(port, service.id))) {
      const message = `Stopped "${holder.name}", but port ${port} has not been released yet. Try again in a moment.`;
      return { ok: false, message, conflict };
    }
    return core.supervisor.start(service);
  }

  // "kill-holder": signal a process this console did not start.
  if (!conflict.holder.pid) {
    const message = conflict.holder.likelyContainer
      ? `Port ${port} is container-published, so there is no process to signal. Stop the container, or start on another port.`
      : `Nothing identifiable is holding port ${port} any more.`;
    core.logs.append(service.id, "warn", message);
    return { ok: false, message, conflict };
  }

  const killed = await core.supervisor.killForeignProcess(conflict.holder.pid, service.id);
  if (!killed.ok) return { ok: false, message: killed.message, conflict };
  if (!(await core.supervisor.waitForPortFree(port, service.id))) {
    const message = `Stopped pid ${conflict.holder.pid}, but port ${port} has not been released yet. Try again in a moment.`;
    return { ok: false, message, conflict };
  }
  return core.supervisor.start(service);
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
