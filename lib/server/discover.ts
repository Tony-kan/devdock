import fs from "node:fs";
import path from "node:path";
import type { ServiceConfig, ServiceKind } from "../types";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".gradle",
  "build",
  "dist",
  "target",
  ".idea",
  ".vscode",
  ".next",
  "__pycache__",
]);

const LOCKFILES = [
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
] as const;

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function slug(value: string): string {
  return value
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** `server.port=8084` in .properties, or `server:\n  port: 8084` in YAML. */
function findServerPort(resourceDir: string): number | null {
  const candidates = [
    "application-dev.properties",
    "application-dev.yaml",
    "application-dev.yml",
    "application.properties",
    "application.yaml",
    "application.yml",
  ];
  for (const file of candidates) {
    const body = readIfExists(path.join(resourceDir, file));
    if (!body) continue;
    const flat = body.match(/^\s*server\.port\s*[=:]\s*(\d+)/m);
    if (flat) return Number(flat[1]);
    const nested = body.match(/^server:\s*\n(?:\s+[\w.-]+:.*\n)*?\s+port:\s*(\d+)/m);
    if (nested) return Number(nested[1]);
  }
  return null;
}

/** `server: { port: 3000 }` in a Vite config. */
function findVitePort(dir: string): number | null {
  for (const file of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
    const body = readIfExists(path.join(dir, file));
    if (!body) continue;
    // Skip the `test.server.deps` block Vitest configs also declare.
    const match = body.match(/\n\s{0,4}server:\s*\{\s*\n\s*(?:host:[^\n]*\n\s*)?port:\s*(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * True when a compose file provides backing services (Postgres, Redis, Keycloak…)
 * rather than packaging the project itself.
 *
 * A `build:` entry means the compose file builds this repo — that is an alternative
 * way to run the project, not infrastructure it depends on, so we leave it out and
 * keep the project's native run command instead.
 */
function isInfraCompose(file: string): boolean {
  const body = readIfExists(file);
  if (!body) return false;
  if (/^\s+build\s*:/m.test(body)) return false;
  return /^\s+image\s*:/m.test(body);
}

function hasSpringBootApp(dir: string): boolean {
  const roots = [path.join(dir, "src/main/java"), path.join(dir, "src/main/kotlin")];
  const stack = roots.filter(exists);
  let scanned = 0;
  while (stack.length && scanned < 4000) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned += 1;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.(java|kt)$/.test(entry.name)) {
        const body = readIfExists(full);
        if (body && body.includes("@SpringBootApplication")) return true;
      }
    }
  }
  return false;
}

function firstScript(scripts: Record<string, string>, names: string[]): string | null {
  for (const name of names) if (scripts[name]) return name;
  return null;
}

const onPathCache = new Map<string, boolean>();

function onPath(binary: string): boolean {
  const cached = onPathCache.get(binary);
  if (cached !== undefined) return cached;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const found = dirs.some((d) => exists(path.join(d, binary)));
  onPathCache.set(binary, found);
  return found;
}

/**
 * Pick the package manager from the lockfile, but fall back to npm when the
 * detected one is not installed — a generated command that cannot run is worse
 * than a slightly wrong one.
 */
function packageManagerFor(dir: string): string {
  for (const [lock, manager] of LOCKFILES) {
    if (!exists(path.join(dir, lock))) continue;
    return onPath(manager) ? manager : "npm";
  }
  return "npm";
}

interface Candidate {
  dir: string;
  rel: string;
}

function classify(candidate: Candidate): ServiceConfig[] {
  const { dir, rel } = candidate;
  const name = path.basename(dir);
  const out: ServiceConfig[] = [];

  const composePath = [
    "docker/dev/docker-compose.yaml",
    "docker/dev/docker-compose.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yaml",
  ].find((p) => exists(path.join(dir, p)) && isInfraCompose(path.join(dir, p)));

  const gradleFile = ["build.gradle", "build.gradle.kts"].find((f) => exists(path.join(dir, f)));
  const packageJsonBody = readIfExists(path.join(dir, "package.json"));

  if (!gradleFile && !packageJsonBody && !composePath) return out;

  // Infrastructure first, so it can be a `dependsOn` target for the service beside it.
  let infraId: string | null = null;
  if (composePath) {
    infraId = `${slug(name)}-infra`;
    out.push({
      id: infraId,
      name: `${name} infra`,
      kind: "Docker",
      cwd: rel,
      command: `docker compose -f ${composePath} up`,
      port: null,
      env: {},
      healthPath: null,
      dependsOn: [],
      autoStart: false,
      repo: rel,
    });
  }

  if (gradleFile) {
    const gradleBody = readIfExists(path.join(dir, gradleFile)) ?? "";
    const isLibrary = /id\s*['"]maven-publish['"]/.test(gradleBody);
    const isSpringApp = !isLibrary && hasSpringBootApp(dir);

    if (isSpringApp) {
      const port = findServerPort(path.join(dir, "src/main/resources")) ?? 8080;
      out.push({
        id: slug(name),
        name,
        kind: "Spring",
        cwd: rel,
        // --console=plain keeps Gradle's ANSI progress bar out of the log pane.
        command: "./gradlew bootRun --console=plain",
        port,
        env: { SPRING_PROFILES_ACTIVE: "dev" },
        healthPath: "/actuator/health",
        dependsOn: infraId ? [infraId] : [],
        autoStart: false,
        repo: rel,
      });
    } else {
      out.push({
        id: slug(name),
        name,
        kind: "Gradle",
        cwd: rel,
        command: isLibrary
          ? "./gradlew publishToMavenLocal --console=plain"
          : "./gradlew build -x test --console=plain",
        port: null,
        env: {},
        healthPath: null,
        dependsOn: [],
        autoStart: false,
        repo: rel,
      });
    }
  }

  if (packageJsonBody) {
    try {
      const pkg = JSON.parse(packageJsonBody) as {
        name?: string;
        scripts?: Record<string, string>;
        workspaces?: string[];
      };
      const scripts = pkg.scripts ?? {};
      const script = firstScript(scripts, ["dev", "start", "storybook"]);
      if (script) {
        const pm = packageManagerFor(dir);
        const isStorybook = script === "storybook";
        // Workspace roots delegate with `-w`, so run the root script as written.
        const port = isStorybook ? 6006 : findVitePort(dir) ?? findViteWorkspacePort(dir, pkg.workspaces);
        out.push({
          id: slug(name),
          name,
          kind: "Node",
          cwd: rel,
          command: `${pm} run ${script}`,
          port,
          env: {},
          healthPath: port ? "/" : null,
          dependsOn: [],
          autoStart: false,
          repo: rel,
        });
      }
    } catch {
      // Unparseable package.json — nothing reliable to generate.
    }
  }

  return out;
}

/** npm-workspace roots keep their Vite config inside the workspace package. */
function findViteWorkspacePort(dir: string, workspaces?: string[]): number | null {
  for (const pattern of workspaces ?? []) {
    if (pattern.includes("*")) continue;
    const port = findVitePort(path.join(dir, pattern));
    if (port) return port;
  }
  return null;
}

/**
 * Scan the workspace for runnable things. Depth 1 covers a flat folder of repos;
 * a directory that yields nothing itself but contains candidates (e.g. `backends/`)
 * is descended into once.
 */
export function discoverServices(root: string): ServiceConfig[] {
  const found: ServiceConfig[] = [];
  const seen = new Set<string>();

  const push = (services: ServiceConfig[]) => {
    for (const service of services) {
      let id = service.id;
      let n = 2;
      while (seen.has(id)) id = `${service.id}-${n++}`;
      seen.add(id);
      found.push({ ...service, id });
    }
  };

  // The root itself may be a project.
  push(classify({ dir: root, rel: "." }));

  for (const child of listDirs(root)) {
    const dir = path.join(root, child);
    const direct = classify({ dir, rel: child });
    if (direct.length > 0) {
      push(direct);
      continue;
    }
    for (const grandchild of listDirs(dir)) {
      push(classify({ dir: path.join(dir, grandchild), rel: path.join(child, grandchild) }));
    }
  }

  // Infra before the services that depend on it, then Spring, then everything else.
  const order: Record<ServiceKind, number> = { Docker: 0, Spring: 1, Node: 2, Gradle: 3, Python: 4, Other: 5 };
  return found.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}
