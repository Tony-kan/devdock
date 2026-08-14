# Devdock — local services control console

A single-screen web app for starting, stopping, restarting, updating and watching the
services in a local workspace. It runs on your own machine only: no auth, no database,
no cloud dependencies. State is one JSON file plus in-memory process handles.

Built as a Next.js 16 app because this repo already had Next, React and Tailwind
installed — the console adds **no new dependencies**. Log streaming uses server-sent
events rather than a WebSocket for the same reason.

## The problem it solves

Bringing up a multi-service project locally is death by a thousand terminal tabs. Each
service has its own start incantation, its own working directory, its own profile or
environment variable, and often its own database and cache container that has to be up
first. Nothing about that is hard — it is just repetitive, easy to get subtly wrong,
and it has to be repeated every morning.

The specific frictions this console removes:

- **No single view of what is up.** Status lives in whichever tab you last looked at.
  Here, every service's status, PID, port, uptime and health sit in one list.
- **`address already in use` tells you nothing.** The console checks the port before
  starting and names the process holding it — including which of your own services it
  is, so you know whether to stop something or change a port.
- **Scattered logs.** Correlating an error across two services means switching tabs and
  losing your scrollback. A combined, colour-coded, searchable stream shows both at
  once, and everything is also written to a file for later.
- **Silent crashes.** A service that dies while you were reading another tab looks
  identical to one that is running. A crash flips the status pill and shows the exit
  code.
- **Repetitive updates.** Where a workspace holds several independent repositories,
  bringing them up to date means one `git pull` per repo, and forgetting to reinstall
  dependencies after a lockfile change produces failures that look unrelated to the
  pull. One action pulls them all, reports each, and prompts for the install.
- **Leftover processes.** Closing a terminal often leaves a child still holding a port.
  Everything started here is killed on shutdown, and anything that escapes is reaped
  on the next start.
- **Dependency ordering.** Starting a service before its database is a guaranteed
  stack trace. `dependsOn` starts infrastructure first and waits for it.

It is deliberately a local tool: loopback-only, no auth, no database, and no state that
matters beyond one JSON file you can read and edit.

## Running it

```bash
npm install     # only needed once
npm run dev
```

Then open <http://127.0.0.1:4800>. The server binds to `127.0.0.1` only, so it is not
reachable from the network. Change the port with `-p` in the `dev` script.

`npm start` runs the same thing against a production build (`npm run build` first).

## Features

**Process control** — start, stop, restart, and start/stop all. Stop sends `SIGTERM`
to the whole process group and escalates to `SIGKILL` after a grace period. "Start
all" honours `dependsOn` ordering and waits for each dependency to become usable.
Tracks real PID, status (`stopped` / `starting` / `running` / `crashed`), uptime, exit
code and restart count.

**Port conflict detection** — before starting, the port is probed on both IPv4 and
IPv6 loopback. If it is taken, the start is refused and the holding process is named,
including which of your own services holds it (matched by process group).

**Git, per service and workspace-wide** — current branch, ahead/behind and dirty
count; `git pull --rebase` with the resulting diffstat streamed into the log pane.
Conflicts are surfaced and **never** auto-resolved. "Install deps" is a separate
action, and the console prompts for it when a pull touched a lockfile or build file.

**Logs** — stdout and stderr captured per service into a ring buffer, streamed live to
the browser, and persisted to `.logs/<service>.log`. Per-service and combined views,
level filter with counts, text search, follow/pause, clear and copy. Colour-coded by
level and by service.

**Health** — polls each service's `healthPath` and shows a pass/fail dot. A process
exiting non-zero is marked crashed.

**Editing** — add a service inline (name, command, port); edit command, working
directory, port, health path, env vars, dependencies, autoStart and the Open URL;
reorder and remove services. Nothing requires restarting the console.

**Keyboard shortcuts** — `s` start · `r` restart · `x` stop · `p` pull ·
`i` install deps · `o` open · `f` follow/pause · `/` focus search · `j`/`k` move the
selection · `Esc` close. Ignored while a text field has focus.

## Choosing the workspace

The workspace the console manages is the `root` field in `services.json`. On first run
it is taken from the `DEVDOCK_ROOT` environment variable if set, and otherwise falls
back to `~/IdeaProjects`. Edit `root` at any time to point it elsewhere.

The root does not have to be a single repository. When it is a directory containing
several independent repos, everything git-related is per-repo:

- The top bar shows a roll-up (`N repos · N dirty · N behind`) on the combined view,
  and the selected service's own branch, ahead/behind and dirty count when a service
  is selected.
- **Pull latest** pulls every repo referenced by a configured service, one at a time,
  reporting each in the log pane.

## First run and `services.json`

On first load the console scans the workspace and writes `services.json`. It detects:

| Found | Becomes |
| --- | --- |
| `build.gradle` plus a `@SpringBootApplication` class | a `Spring` service running `./gradlew bootRun --console=plain` with `SPRING_PROFILES_ACTIVE=dev`, port read from `application*.properties`/`.yaml`, health at `/actuator/health` |
| `build.gradle` with the `maven-publish` plugin | a `Gradle` library task running `./gradlew publishToMavenLocal` |
| `package.json` with a `dev`, `start` or `storybook` script | a `Node` service running that script with the detected package manager, port read from the Vite config |
| a compose file whose services are all `image:` based | a `Docker` infra entry, wired as `dependsOn` for the service beside it |

A compose file containing `build:` is skipped — that packages the project itself
rather than providing infrastructure it depends on, and the project already has a
native run command.

The scan looks one level below the root, and descends a second level into directories
that are not projects themselves but contain projects (a `backends/` folder, say).

`services.json` is re-read whenever its mtime changes, so editing it by hand takes
effect on the next request. The console is never restarted to pick up config. **Add**
in the UI and **Re-scan** write to the same file.

Each entry looks like this:

```json
{
  "id": "supplier-service",
  "name": "supplier-service",
  "kind": "Spring",
  "cwd": "backends/supplier-service",
  "command": "./gradlew bootRun --console=plain",
  "port": 8082,
  "env": { "SPRING_PROFILES_ACTIVE": "dev" },
  "healthPath": "/actuator/health",
  "dependsOn": ["supplier-service-infra"],
  "autoStart": false,
  "repo": "backends/supplier-service",
  "url": null
}
```

`cwd` and `repo` are relative to `root`; absolute paths also work. `repo` is the git
repository the service belongs to — set it when a service lives in a subdirectory of a
larger repo. `url` overrides the `http://localhost:<port>` address used by **Open**.

## Adding a service

Press **Add** in the service list, fill in name, command and port, and press Add. That
is the whole flow — no restart, no file editing. Everything else is under **Edit** on
the selected service.

## Logs

- Per service, a ring buffer of 3000 lines, streamed to the browser over SSE.
- Also appended to `.logs/<service-id>.log`, rotated to `.log.1` past 5 MB.
- The console's own messages go to `.logs/console.log` and appear under the service id
  `console` in the combined view.
- Levels are inferred from the text (`ERROR`, `Exception`, stack frames → error;
  `WARN` → warn). Lines on stderr default to **warn**, not error, because Gradle, Vite
  and Docker Compose all write ordinary progress there.
- Clear empties the in-memory buffer; the file on disk is left intact.

## How processes are handled

- Every service is spawned in **its own process group**, so stopping it kills the
  whole tree (`gradlew` → `java`, `npm` → `vite`) rather than just the shell.
- Stop sends `SIGTERM` to the group, waits 8 seconds, then `SIGKILL`. Both are logged
  with the exact command that ran.
- Exit code 0 → `stopped`. Any other code, or a signal that was not requested →
  `crashed`, with the code shown in the status pill.
- On console shutdown every group is terminated, so nothing is orphaned. If the
  console is `SIGKILL`ed instead, survivors are recorded in `.logs/runtime-state.json`
  and reaped on the next start — a recorded pid is only killed when `/proc` still
  shows the same command line, so a recycled pid cannot be mistaken for one of ours.
- Health checks poll every 10 seconds with a `devdock-health-check` user agent.

## Limitations

**A service still needs its own toolchain.** The console runs the command; it does not
provision anything. If a project requires a runtime or JDK version that is not
installed — for example a Gradle toolchain requesting a Java version absent from the
machine — the start fails and the error appears in the log pane. Fixing that means
installing the toolchain.

**Declared ports can collide.** Generated ports come from what each project declares.
Projects that declare nothing fall back to their framework default, so several
services can end up claiming the same port (Spring services at 8080, Vite apps at
3000) and only one of each group can run at a time. The console deliberately does
**not** inject port overrides: services commonly reference each other by port in their
own configuration, so silently moving one would break integration in a way that is
invisible from here. To run several at once, set the port variable in a service's env
under **Edit** (`SERVER_PORT` for Spring, a `--port` flag for Vite) and update the
URLs in whatever calls it.

**Only processes the console started are tracked.** Anything you launched from a
terminal is invisible to the status list; the port conflict detector is what tells you
it is there.

**Docker containers can outlive a hard kill.** The Stop action stops compose
containers properly. If the console itself is `SIGKILL`ed, compose receives `SIGKILL`
too and its containers may keep running — stop them with the infra service's Stop, or
`docker compose down`.

**Changing the console's own server code needs a restart.** Process state deliberately
lives on `globalThis` so it survives hot reloading; the same mechanism means an
already-constructed supervisor keeps its old methods, so edits under `lib/server/`
only take effect after restarting the console.

**`next build` warns about dynamic filesystem access.** Reading arbitrary paths is
what this tool does, so Turbopack cannot narrow its file trace. The warnings are
expected and harmless here.

**Levels are heuristics.** Log level comes from pattern-matching each line, not from a
structured stream. Unusual output formats can be mislabelled; the unfiltered `all`
view is always the source of truth.

## Layout

```
app/
  page.tsx                       server component; boots the supervisor, first paint
  api/state/route.ts             full snapshot (services, runtime, git, counts)
  api/stream/route.ts            SSE: hello, log, state, server-error
  api/logs/route.ts              recent buffer (GET), clear (DELETE)
  api/services/route.ts          list, add, reorder, re-scan
  api/services/[id]/route.ts     edit, remove
  api/services/[id]/[action]/    start, stop, restart, pull, install
  api/bulk/[action]/route.ts     start-all, stop-all, pull-all
components/                      the single-screen UI
lib/types.ts                     shared types (no Node imports)
lib/server/
  core.ts        globalThis singleton, snapshot assembly, git cache
  supervisor.ts  spawn, signal, status, health, orphan reaping
  logs.ts        ring buffers, level classification, file persistence
  config.ts      services.json load/save, dependency ordering
  discover.ts    workspace scan
  git.ts         status, pull --rebase, install commands
  ports.ts       port probing and holder identification
  exec.ts        one-shot command runner with line streaming
```

`services.json` and `.logs/` are gitignored — they are machine-local.
