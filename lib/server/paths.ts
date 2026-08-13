import path from "node:path";
import os from "node:os";

/** Where the console itself lives (this Next.js project). */
export const CONSOLE_DIR = process.cwd();

export const CONFIG_PATH = path.join(CONSOLE_DIR, "services.json");
export const LOG_DIR = path.join(CONSOLE_DIR, ".logs");
export const STATE_PATH = path.join(LOG_DIR, "runtime-state.json");

/**
 * The workspace this console controls. `DEVDOCK_ROOT` wins; otherwise we fall back
 * to the sibling IdeaProjects tree, then to the console directory itself.
 */
export function defaultRoot(): string {
  const fromEnv = process.env.DEVDOCK_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), "IdeaProjects");
}

/** Resolve a service `cwd`/`repo` (possibly relative) against the workspace root. */
export function resolveIn(root: string, target: string): string {
  if (!target || target === ".") return root;
  return path.isAbsolute(target) ? target : path.resolve(root, target);
}

/** Render an absolute path back to a root-relative label for the UI. */
export function relativeToRoot(root: string, target: string): string {
  const rel = path.relative(root, target);
  return rel === "" ? "." : rel;
}

export function logFileFor(serviceId: string): string {
  return path.join(LOG_DIR, `${serviceId.replace(/[^\w.-]/g, "_")}.log`);
}
