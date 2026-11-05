import fs from "node:fs";
import path from "node:path";
import { capture, run, type LineSink } from "./exec";
import type { GitInfo, ServiceConfig } from "../types";

/** Files whose change means the ecosystem's dependencies should be reinstalled. */
const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "gradle.lockfile",
  "gradle/wrapper/gradle-wrapper.properties",
  "pyproject.toml",
  "requirements.txt",
];

const CONFLICT_MARKERS = [
  "CONFLICT",
  "could not apply",
  "Automatic merge failed",
  "Resolve all conflicts manually",
  "needs merge",
];

export async function gitInfo(dir: string, rel: string): Promise<GitInfo> {
  const base: GitInfo = {
    repo: rel,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: 0,
    isRepo: false,
    error: null,
    checkedAt: Date.now(),
  };

  const inside = await capture("git", ["rev-parse", "--is-inside-work-tree"], dir, 5000);
  if (inside.spawnError) return { ...base, error: `git unavailable: ${inside.spawnError}` };
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return base;

  const [branch, upstream, status] = await Promise.all([
    capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir, 5000),
    capture("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir, 5000),
    capture("git", ["status", "--porcelain"], dir, 8000),
  ]);

  const info: GitInfo = {
    ...base,
    isRepo: true,
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    upstream: upstream.code === 0 ? upstream.stdout.trim() || null : null,
    dirty: status.code === 0 ? status.stdout.split("\n").filter((l) => l.trim() !== "").length : 0,
  };

  if (info.upstream) {
    const counts = await capture("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"], dir, 8000);
    if (counts.code === 0) {
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
      info.behind = Number.isFinite(behind) ? behind : 0;
      info.ahead = Number.isFinite(ahead) ? ahead : 0;
    }
  }

  return info;
}

export interface PullOutcome {
  ok: boolean;
  conflicts: boolean;
  needsInstall: boolean;
  message: string;
  /** Set when there was nothing to pull because the directory is not a repository root. */
  skipped?: boolean;
}

/** Failures where the server dropped the connection rather than refusing the pull. */
const TRANSIENT_REMOTE_ERRORS = ["Could not read from remote repository", "Connection reset", "Connection closed by"];

/**
 * `git pull --rebase` with the full output streamed to the log pane.
 *
 * `--autostash` lets a repo with uncommitted edits — a local port tweak, say — pull at
 * all; plain `--rebase` refuses outright. The edits are stashed, the rebase runs, and
 * they are re-applied. If re-applying conflicts, git keeps them in `git stash list`
 * rather than losing them, and that is reported below.
 *
 * Conflicts are reported and left exactly as git left them — nothing here aborts,
 * resets or resolves, because that would silently discard the user's work.
 */
export async function gitPull(dir: string, rel: string, sink: LineSink): Promise<PullOutcome> {
  // Only pull a directory that is itself a repository root. Infra kept inside another
  // repo's ignored folder — or anything not under git at all — would otherwise pull
  // whatever repository happens to contain it.
  const top = await capture("git", ["rev-parse", "--show-toplevel"], dir, 5000);
  if (top.code !== 0 || path.resolve(top.stdout.trim()) !== fs.realpathSync(dir)) {
    sink("info", `${rel}: not a git repository root — nothing to pull.`);
    return { ok: true, conflicts: false, needsInstall: false, skipped: true, message: `${rel}: not a repository` };
  }

  const upstream = await capture("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir, 5000);
  if (upstream.code !== 0) {
    const branch = (await capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir, 5000)).stdout.trim() || "HEAD";
    sink("warn", `${rel}: branch "${branch}" has no upstream, so there is nothing to pull from.`);
    sink("warn", `${rel}: push it with \`git push -u origin ${branch}\`, or switch to a tracked branch.`);
    return { ok: false, conflicts: false, needsInstall: false, message: `${rel}: no upstream for "${branch}"` };
  }

  const args = ["pull", "--rebase", "--autostash", "--stat"];
  sink("info", `$ git -C ${rel} ${args.join(" ")}`);
  let result = await run("git", args, { cwd: dir, sink, timeoutMs: 120_000 });

  // An SSH server rate-limiting connections drops some of a burst of pulls. One retry
  // after a pause clears it; a real auth or network failure fails the same way twice.
  if (result.code !== 0 && TRANSIENT_REMOTE_ERRORS.some((m) => result.stderr.includes(m))) {
    sink("warn", `${rel}: the remote dropped the connection — retrying once.`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    result = await run("git", args, { cwd: dir, sink, timeoutMs: 120_000 });
  }

  if (result.spawnError) {
    sink("error", `git could not run: ${result.spawnError}`);
    return { ok: false, conflicts: false, needsInstall: false, message: `git could not run in ${rel}` };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const conflicts = CONFLICT_MARKERS.some((marker) => combined.includes(marker));

  if (combined.includes("Applying autostash resulted in conflicts")) {
    sink("error", `${rel}: pulled, but your local edits conflicted with what came in.`);
    sink("warn", `${rel}: they are safe in \`git -C ${rel} stash list\` — re-apply with \`git stash pop\` and resolve.`);
    return { ok: false, conflicts: true, needsInstall: false, message: `${rel}: local edits conflicted — kept in the stash` };
  }

  if (conflicts) {
    sink("error", `${rel}: rebase stopped on conflicts — resolve them manually, then re-run the pull.`);
    sink("warn", `${rel}: nothing was auto-resolved. Use \`git -C ${rel} rebase --abort\` to back out.`);
    return { ok: false, conflicts: true, needsInstall: false, message: `${rel}: merge conflicts need manual resolution` };
  }

  if (result.code !== 0) {
    sink("error", `${rel}: pull failed with exit code ${result.code}`);
    return { ok: false, conflicts: false, needsInstall: false, message: `${rel}: pull failed (exit ${result.code})` };
  }

  // `--stat` already prints a diffstat when the pull moved HEAD. Only fall back to an
  // explicit one when it did not, so the pane does not show the same summary twice.
  const alreadySummarised = /\d+ files? changed/.test(combined);
  if (!alreadySummarised) {
    // ORIG_HEAD is set by pull/rebase, so this is the diffstat for what just landed.
    const diff = await capture("git", ["diff", "--stat", "ORIG_HEAD", "HEAD"], dir, 15_000);
    const diffBody = diff.code === 0 ? diff.stdout.trim() : "";
    if (diffBody) {
      sink("info", `--- ${rel}: changes pulled ---`);
      for (const line of diffBody.split("\n")) sink("info", line);
    } else {
      sink("info", `${rel}: already up to date.`);
    }
  }

  const touchedFiles = await capture("git", ["diff", "--name-only", "ORIG_HEAD", "HEAD"], dir, 15_000);
  const names = touchedFiles.code === 0 ? touchedFiles.stdout.split("\n").map((l) => l.trim()) : [];
  const hits = names.filter((name) => DEPENDENCY_FILES.some((dep) => name === dep || name.endsWith(`/${dep}`)));
  const needsInstall = hits.length > 0;
  if (needsInstall) {
    sink("warn", `${rel}: dependency files changed (${hits.join(", ")}) — run "Install deps".`);
  }

  return {
    ok: true,
    conflicts: false,
    needsInstall,
    message: needsInstall ? `${rel}: pulled — dependencies need installing` : `${rel}: pulled`,
  };
}

/** The right "install dependencies" command for a service's ecosystem. */
export function installCommandFor(service: ServiceConfig): string | null {
  switch (service.kind) {
    case "Node": {
      const manager = service.command.match(/^(npm|pnpm|yarn)\b/)?.[1] ?? "npm";
      return manager === "yarn" ? "yarn install" : `${manager} install`;
    }
    case "Spring":
    case "Gradle":
      // Resolves and caches every dependency, and compiles, without running tests.
      return "./gradlew classes --console=plain";
    case "Docker": {
      const file = service.command.match(/-f\s+(\S+)/)?.[1];
      return file ? `docker compose -f ${file} pull` : "docker compose pull";
    }
    case "Python":
      return "python3 -m pip install -r requirements.txt";
    default:
      return null;
  }
}
