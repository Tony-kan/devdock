import fs from "node:fs";
import path from "node:path";
import type { ServiceConfig } from "../types";

export interface PortOverride {
  /** Extra environment for the child process. */
  env: Record<string, string>;
  /** The command to run, possibly rewritten to accept a port. */
  command: string;
  /** Human-readable description of what is being done, shown in the log pane. */
  mechanism: string;
  /** Set when the mechanism changes behaviour or might not reach the real server. */
  caveat: string | null;
}

/** `npm run dev`, `pnpm run start`, `yarn dev` … */
const RUN_SCRIPT = /^(npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/;

/** A root script that delegates into a workspace package: `npm run dev -w web`. */
const DELEGATES = /(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)\s+(?:-w|--workspace)[\s=]+(\S+)/;

function readPackage(dir: string): { name?: string; scripts?: Record<string, string>; workspaces?: string[] } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
      workspaces?: string[];
    };
  } catch {
    return null;
  }
}

/** Expand the `workspaces` patterns far enough to find a package by name. */
function workspaceDirs(rootDir: string, patterns: string[]): string[] {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      dirs.push(path.join(rootDir, pattern));
      continue;
    }
    const parent = path.join(rootDir, pattern.slice(0, pattern.indexOf("*")));
    try {
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(parent, entry.name));
      }
    } catch {
      // Pattern points nowhere on this machine.
    }
  }
  return dirs;
}

interface Resolved {
  /** The script body that will ultimately run. */
  script: string | null;
  /** Set when the command reaches it through an npm workspace. */
  workspace: string | null;
  manager: string;
  scriptName: string | null;
}

/**
 * Follow `<pm> run <name>` to the script it runs, through one level of workspace
 * delegation, so we can tell what will really execute rather than guessing from the
 * command string.
 */
function resolveCommand(dir: string, command: string): Resolved {
  const match = command.match(RUN_SCRIPT);
  if (!match) return { script: null, workspace: null, manager: "npm", scriptName: null };

  const manager = match[1];
  const scriptName = match[2];
  const root = readPackage(dir);
  const script = root?.scripts?.[scriptName] ?? null;
  if (!script) return { script: null, workspace: null, manager, scriptName };

  const delegated = script.match(DELEGATES);
  if (!delegated) return { script, workspace: null, manager, scriptName };

  const [, innerScriptName, workspace] = delegated;
  for (const candidate of workspaceDirs(dir, root?.workspaces ?? [])) {
    const pkg = readPackage(candidate);
    if (pkg?.name !== workspace) continue;
    return { script: pkg.scripts?.[innerScriptName] ?? null, workspace, manager, scriptName: innerScriptName };
  }

  return { script, workspace, manager, scriptName: innerScriptName };
}

/**
 * Work out how to start a service on a different port than it is configured for.
 *
 * Returns null when the command cannot sensibly take one — a Docker Compose entry
 * publishes ports from its compose file, so the fix there is to edit that file.
 *
 * Nothing here is applied silently: the caller logs `mechanism` (and `caveat`) before
 * spawning, because a port override the command ignores looks exactly like a console
 * bug otherwise.
 */
export function planPortOverride(service: ServiceConfig, port: number, cwd: string): PortOverride | null {
  const command = service.command;

  if (service.kind === "Docker") return null;

  if (service.kind === "Spring" || service.kind === "Gradle") {
    // Spring Boot reads SERVER_PORT ahead of application.properties.
    return {
      env: { SERVER_PORT: String(port) },
      command,
      mechanism: `SERVER_PORT=${port}`,
      caveat: "Services that call this one by port still point at the old one — update their configuration too.",
    };
  }

  const resolved = resolveCommand(cwd, command);
  const target = `${command} ${resolved.script ?? ""}`;
  const runsScript = RUN_SCRIPT.test(command);

  if (/\bnext\b/.test(target)) {
    return {
      env: { PORT: String(port) },
      command: runsScript ? `${command} -- -p ${port}` : `${command} -p ${port}`,
      mechanism: `-p ${port} appended, PORT=${port}`,
      caveat: null,
    };
  }

  if (/\bvite\b/.test(target)) {
    // --strictPort makes a failed override loud instead of silently sliding to 3001.
    const flags = `--port ${port} --strictPort`;

    if (resolved.workspace) {
      // npm does not forward extra args through `-w`, so appending to the root script
      // would be silently dropped. Invoke Vite in the workspace package instead.
      return {
        env: { PORT: String(port) },
        command: `${resolved.manager} exec -w ${resolved.workspace} -- vite ${flags}`,
        mechanism: `${resolved.manager} exec -w ${resolved.workspace} -- vite ${flags}`,
        caveat: `This runs Vite directly in the ${resolved.workspace} workspace, because npm will not pass a port flag through "-w". Any other flags from that package's "${resolved.scriptName}" script are not applied.`,
      };
    }

    return {
      env: { PORT: String(port) },
      command: runsScript ? `${command} -- ${flags}` : `${command} ${flags}`,
      mechanism: `${flags} appended`,
      caveat: null,
    };
  }

  // Unknown command: PORT is the widest convention, but plenty of tools ignore it.
  return {
    env: { PORT: String(port) },
    command,
    mechanism: `PORT=${port}`,
    caveat: "This command's port flag is unknown, so only PORT is set — the process may ignore it.",
  };
}
