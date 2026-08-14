# Devdock — local services control console

A single-screen web app for starting, stopping, restarting, updating and watching the
services in a local workspace. It runs on your machine only, has no auth, no database
and no cloud dependencies: state is one JSON file plus in-memory process handles.

Built as a Next.js 16 app because this repo already had Next, React and Tailwind
installed — the console adds **no new dependencies**. Log streaming uses server-sent
events rather than a WebSocket for the same reason.

## Running it

```bash
npm install     # only needed once
npm run dev
```

Then open <http://127.0.0.1:4800>. The server binds to `127.0.0.1` only — it is not
reachable from the network. Change the port with `-p` in the `dev` script.

`npm start` runs the same thing against a production build (`npm run build` first).

## What it controls

The workspace it manages defaults to `~/IdeaProjects` and is recorded as `root` in
`services.json`. Point it somewhere else by editing that field, or by setting
`DEVDOCK_ROOT` before the first run.

Note that this workspace is **not one repository** — it is a folder containing ~21
independent git repos. Everything git-related is therefore per-repo:

- The top bar shows a roll-up (`N repos · N dirty · N behind`) on the combined view,
  and the selected service's own branch, ahead/behind and dirty count when a service
  is selected.
- **Pull latest** pulls every repo referenced by a configured service, one at a time,
  reporting each in the log pane.

## First run and `services.json`

On first load the console scans the workspace and writes `services.json`. It detects:

| Found | Becomes |
| --- | --- |
| `build.gradle` + a `@SpringBootApplication` class | a `Spring` service running `./gradlew bootRun --console=plain` with `SPRING_PROFILES_ACTIVE=dev`, port read from `application-dev.properties`, health at `/actuator/health` |
| `build.gradle` + the `maven-publish` plugin | a `Gradle` library task running `./gradlew publishToMavenLocal` |
| `package.json` with a `dev`, `start` or `storybook` script | a `Node` service running that script, port read from the Vite config |
| a compose file made only of `image:` services | a `Docker` infra entry, wired as `dependsOn` for the service beside it |

A compose file containing `build:` is skipped — that packages the project itself
rather than providing infrastructure it depends on, and the project already has a
native run command.

`services.json` is re-read whenever its mtime changes, so editing it by hand takes
effect on the next request. The console is never restarted to pick up config.

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

`cwd` and `repo` are relative to `root` (absolute paths also work). `repo` is the git
repository the service belongs to — set it when a service lives in a subdirectory of
a larger repo.

## Adding a service

Press **Add** in the service list, fill in name, command and port, and press Add.
That is the whole flow — no restart, no file editing. Everything else (env vars,
health path, dependencies, working directory, autoStart, the Open URL) is under
**Edit** on the selected service.

## Logs

- Captured per service into a ring buffer of 3000 lines and streamed to the browser
  over SSE.
- Also appended to `.logs/<service-id>.log`, rotated to `.log.1` past 5 MB.
- The console's own messages go to `.logs/console.log` and appear under the service
  id `console` in the combined view.
- Levels are inferred from the text (`ERROR`/`Exception`/stack frames → error,
  `WARN` → warn). Lines on stderr default to **warn**, not error, because Gradle,
  Vite and Docker Compose all write ordinary progress there.
- Filter by level, search, follow/pause, clear and copy from the toolbar. Clear
  empties the in-memory buffer; the file on disk is left intact.

## Keyboard shortcuts

`s` start · `r` restart · `x` stop · `p` pull · `i` install deps · `o` open ·
`f` follow/pause · `/` focus search · `j`/`k` move the selection · `Esc` close.
They are ignored while a text field has focus.

## How processes are handled

- Every service is spawned in **its own process group**, so stopping it kills the
  whole tree (`gradlew` → `java`, `npm` → `vite`) rather than just the shell.
- Stop sends `SIGTERM` to the group, waits 8 seconds, then sends `SIGKILL`. Both are
  logged with the exact command.
- Exit code 0 → `stopped`. Anything else, or a signal we did not ask for → `crashed`,
  with the code shown in the status pill.
- On console shutdown all groups are terminated, so nothing is orphaned. If the
  console is `SIGKILL`ed instead, the survivors are recorded in
  `.logs/runtime-state.json` and reaped on the next start — a recorded pid is only
  killed when `/proc` still shows the same command line, so a recycled pid cannot be
  mistaken for ours.
- Before starting, the port is probed on **both** IPv4 and IPv6 loopback. If it is
  taken the start is refused and the holder named — including which of your own
  services holds it, matched by process group.
- Health checks poll `healthPath` every 10 seconds with a `devdock-health-check`
  user agent. Any service that logs incoming requests will log those polls too.

## Known limitations in this workspace

These are properties of the workspace, not bugs in the console — it surfaces them
rather than hiding them.

1. **Gradle services will not start until a JDK 21 is installed.** Every backend
   requests `languageVersion = 21` via a Gradle toolchain, the wrappers are Gradle
   8.x with no toolchain resolver plugin, and only JDK 17 is present. The failure
   appears in the log pane.
2. **Ports collide by default.** Six backends have no `server.port` and so default to
   8080; all nine UIs are configured on 3000. Only one of each group can run at a
   time. The console deliberately does **not** inject `SERVER_PORT` overrides: the
   services' `application-dev.properties` reference each other by port, so silently
   moving one would break integration invisibly. To run several at once, set
   `SERVER_PORT` in a service's env under **Edit** and update the corresponding
   `*.url` properties in the repos that call it.
3. Services started outside the console are not tracked — the console only manages
   processes it spawned. The port conflict detector is what tells you about them.
4. `docker compose up` containers are stopped properly by the Stop action. If the
   console is hard-killed, compose gets `SIGKILL` and its containers may keep
   running; stop them with the infra service's Stop, or `docker compose down`.
5. Editing the console's own server code under `lib/server/` needs a console restart.
   Process state survives HMR by design (it lives on `globalThis`), which also means
   the already-constructed supervisor keeps its old methods.

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
