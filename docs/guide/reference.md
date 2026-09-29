---
title: "Reference"
description: "Every tool with its input, output and errors, the HTTP endpoints, the environment variables, the projects file, and the containers devbox-mcp runs."
order: 5
section: "Reference"
---

## Tools

| Tool | Input | Output |
|---|---|---|
| `list_projects` | none | a JSON array of projects |
| `run_tests` | `project`, a string | the test output |
| `sonar_scan` | `project`, a string | the scanner output |
| `sonar_quality_gate` | `project`, a string | a JSON gate summary |

Each result carries one `text` content item. A failure comes back as a result with `isError: true` and the message as its text, rather than as a JSON-RPC error: the MCP SDK that [package-lock.json](../../package-lock.json) pins, 1.30.1, turns an exception in a handler, and an argument that fails validation, into such a result. A call without `project` gets `MCP error -32602: Input validation error: Invalid arguments for tool run_tests: Required at project`.

### list_projects

Lists the projects the other tools accept. Without `PROJECTS_FILE`, a project is each directory directly under `PROJECTS_ROOT`; files and symbolic links do not count. With it, a project is each name in the file that has a directory under `PROJECTS_ROOT` ([src/projects.js](../../src/projects.js)).

The text is the array as indented JSON, one object per project:

| Field | Value |
|---|---|
| `name` | the directory name, which the other tools take as `project` |
| `type` | `dotnet`, `npm`, `pytest`, or `null` for no toolchain |
| `timeoutMs` | the `run_tests` timeout, in milliseconds |
| `memory` | the `run_tests` memory limit, such as `2g` |
| `cpus` | the `run_tests` CPU limit |

The tool's description, which clients show the assistant, includes the absolute `PROJECTS_ROOT` path, and it adds "named in the projects file" when `PROJECTS_FILE` is set.

It fails with a [projects file](#projects-file) error, or with `ENOENT` when `PROJECTS_ROOT` does not exist.

### run_tests

Runs the project's test command in a one-shot container ([Containers](#containers)) and waits for it to exit. The text is the last 20,000 characters of stdout and stderr together. `isError` is `true` when the command exits non-zero or the timeout kills the run, and a run that the timeout kills ends with the line `devbox-mcp: timed out after <n>s`.

| Error text | Cause |
|---|---|
| `unknown project "<name>" — call list_projects first` | `<name>` is not in the `list_projects` output |
| `no supported toolchain detected for "<name>"` | the project's `type` is `null` |
| `could not run docker: <reason>` | the docker CLI did not start, such as `spawn docker ENOENT` when it is not on `PATH` |
| `busy: <runs> already running, the limit of <n> (MAX_CONCURRENT_RUNS); call again when one finishes` | `MAX_CONCURRENT_RUNS` runs are in progress; `<runs>` lists each as `<tool> <project> (<age>s)` |

A projects file error comes back as it does from `list_projects`.

### sonar_scan

Checks the configuration and the project, wakes SonarQube unless `SONAR_CONTAINERS` is empty, then runs `sonarsource/sonar-scanner-cli:latest` against the checkout ([Containers](#containers)). The text is the last 20,000 characters of the scanner's output, and `isError` is `true` when the scanner exits non-zero.

| Error text | Cause |
|---|---|
| `SONAR_HOST_URL / SONAR_TOKEN not configured` | either variable is empty |
| `unknown project "<name>" — call list_projects first` | as for `run_tests` |
| `no sonar-project.properties in "<name>"` | the file is missing at the root |
| `docker start <container> failed: <output>` | a start in the wake failed |
| `SonarQube at <url> not UP after <n>s (last: <last>)` | the wake timed out |
| `could not run docker: <reason>` | as for `run_tests`; in the wake it follows `docker start <container> failed:` |
| `busy: ...` | as for `run_tests`, checked before the wake and again before the scan |

A projects file error comes back here too, since the project lookup reads the file.

### sonar_quality_gate

Runs the same checks and wake as `sonar_scan`, reads `sonar.projectKey` from the project's `sonar-project.properties`, and asks SonarQube for the project's latest analysis task and its gate ([src/sonar-gate.js](../../src/sonar-gate.js)). The text is indented JSON:

| Field | Value |
|---|---|
| `projectKey` | the key from `sonar-project.properties` |
| `status` | SonarQube's gate status; `NONE` when it gives none |
| `pending` | `true` while a task for the project is queued or running |
| `lastTask` | `status`, `submittedAt`, `executedAt` of the latest task, or `null` |
| `conditions` | `metric`, `status`, `actual`, `comparator`, `threshold` per condition |

Besides the configuration, project and wake errors of `sonar_scan`:

| Error text | Cause |
|---|---|
| `no sonar.projectKey in "<name>"'s sonar-project.properties` | no key line in the file |
| `SonarQube /api/ce/component: <reason>` | SonarQube refused the task lookup |
| `SonarQube /api/qualitygates/project_status: <reason>` | SonarQube refused the gate lookup |

`<reason>` is SonarQube's own message, or `HTTP <status>`. On a 401 or 403, the error ends with `(reading the gate needs a token allowed to call the web API, e.g. a user token with Browse on the project)`. Each request has a 10-second timeout; a timeout or a network failure returns the runtime's message instead.

## HTTP endpoints

| Request | Answer |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP, one `message` event per request |
| `GET /healthz` | `200` with the body `ok` |
| any other | `404` from Express |

`POST /mcp` needs `Content-Type: application/json` and an `Accept` header that lists both `application/json` and `text/event-stream`. Without them, the MCP SDK's transport answers `415` or `406`. A notification gets `202` and no body.

The transport is stateless (`sessionIdGenerator: undefined` in [src/index.js](../../src/index.js)): it issues no `Mcp-Session-Id`, needs no `initialize` before other requests, and has no `GET /mcp` stream, which answers `404`. `initialize` reports the server as `devbox-mcp`, version `0.7.0`, with the `tools` capability. The server listens on `PORT` on every interface and checks no credentials.

Each request gets its own `McpServer` and transport, so the server answers a request that arrives while a tool call runs ([test/index.test.js](../../test/index.test.js)). A `notifications/cancelled` gets `202` and cancels nothing: the server that receives it has no such call ([Status](status.md#requests-during-a-tool-call)). An exception in the `POST /mcp` route answers `500`, with the JSON-RPC error `-32603` `Internal server error` and `id: null`, when no response has started ([src/index.js](../../src/index.js)).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PROJECTS_ROOT` | `/srv/chargehand/repos` | the directory of checkouts |
| `PROJECTS_FILE` | unset | the projects file; unset, every directory is a project |
| `DOCKER_HOST` | the docker CLI's default | where the docker CLI sends API calls: the proxy |
| `RUN_TIMEOUT_MS` | `600000` | default `run_tests` timeout; the `sonar_scan` timeout |
| `MAX_CONCURRENT_RUNS` | `1` | how many `run_tests` and `sonar_scan` containers run at once |
| `SONAR_HOST_URL` | unset | SonarQube's URL, reachable by address |
| `SONAR_TOKEN` | unset | the token for the scanner and the web API |
| `SONAR_CONTAINERS` | `sonarqube-db-1,sonarqube-sonarqube-1` | containers to start, in order, before a SonarQube call |
| `SONAR_WAKE_TIMEOUT_MS` | `180000` | how long to wait for SonarQube to report `UP` |
| `PORT` | `8000` | the HTTP port; the image sets `8000` too |

devbox-mcp itself never reads `DOCKER_HOST`: the docker CLI it spawns inherits the environment and reads it. devbox-mcp reads the other variables once at startup ([src/index.js](../../src/index.js)), and the projects file they point to on every call. `PROJECTS_ROOT` becomes an absolute path. An empty value counts as unset, except for `SONAR_CONTAINERS`, where an empty string turns the wake off. `SONAR_CONTAINERS` is a comma-separated list; the timeouts are milliseconds. `MAX_CONCURRENT_RUNS` has to be a whole number of at least 1; any other value stops the server at startup with `MAX_CONCURRENT_RUNS must be a positive integer`.

## Projects file

```json title="projects.json"
{
  "projects": {
    "my-web": { "toolchain": "npm", "timeoutMs": 900000, "memory": "3g", "cpus": 1.5 }
  }
}
```

Every key in an entry is optional, and an entry may be `{}` ([src/projects.js](../../src/projects.js)):

| Key | Accepted values | Default |
|---|---|---|
| `toolchain` | `dotnet`, `npm`, `pytest` | detection |
| `timeoutMs` | a positive integer | `RUN_TIMEOUT_MS` |
| `memory` | a whole number, then `k`, `m` or `g` | `2g` |
| `cpus` | a number above 0, at most 16 | `2` |

A name has to match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. devbox-mcp reads the file on every call and checks all of it before any value reaches `docker run`, so one bad entry fails every call with one of these messages:

```text
projects file: expected {"projects": {...}}
projects file: "<name>": not a plain directory name
projects file: "<name>": expected an object
projects file: "<name>": unknown key "<key>"
projects file: "<name>": toolchain must be one of dotnet, npm, pytest
projects file: "<name>": timeoutMs must be a positive integer
projects file: "<name>": memory must look like "2g" or "1536m"
projects file: "<name>": cpus must be a number between 0 and 16
```

A missing file fails with `ENOENT`, and a file that is not JSON fails with the parser's message.

## Toolchains

Detection checks the root of the checkout in this order and takes the first match ([src/toolchains.js](../../src/toolchains.js)):

| Toolchain | Marker | Image |
|---|---|---|
| `dotnet` | a `.sln`, `.slnx` or `.csproj` file | `mcr.microsoft.com/dotnet/sdk:<major>.0` |
| `npm` | `package.json` | `node:20-slim` |
| `pytest` | `pyproject.toml` or `requirements.txt` | `python:3.12-slim` |

`<major>` comes from `sdk.version` in `global.json` when the version starts with three dot-separated numbers, and is `8` otherwise. The container runs the command with `sh -c`:

```bash title="Test commands, per toolchain"
# dotnet
cp -r /repo/. /work && cd /work && dotnet test --nologo
# npm
cp -r /repo/. /work && cd /work && npm ci && npm test
# pytest
cp -r /repo/. /work && cd /work && (test -f requirements.txt && pip install -q -r requirements.txt || true) && pytest -q
```

## Containers

`run_tests` and `sonar_scan` each start one container with `docker run --rm`, so Docker removes it when it exits:

| Setting | `run_tests` | `sonar_scan` |
|---|---|---|
| name | `devbox-run-<uuid>` | `devbox-sonar-<uuid>` |
| image | the toolchain's | `sonarsource/sonar-scanner-cli:latest` |
| checkout | `/repo`, read-only | `/usr/src`, read-only |
| scratch | tmpfs at `/work`, `size=4g`, `exec` | none |
| memory and CPUs | the project's; default `2g` and `2` | `2g` and `2` |
| timeout | the project's `timeoutMs` | `RUN_TIMEOUT_MS` |
| environment | nothing added | `SONAR_HOST_URL`, `SONAR_TOKEN` |
| network | Docker's default | Docker's default |

The `run_tests` arguments, from [src/index.js](../../src/index.js):

```text
docker run --rm --name devbox-run-<uuid> --memory=<memory> --cpus=<cpus>
  -v <PROJECTS_ROOT>/<project>:/repo:ro --tmpfs /work:size=4g,exec -w /work
  <image> sh -c <command>
```

Neither container gets `--privileged`, `--network`, an added capability, or a mount beyond the checkout and the tmpfs. The wake runs `docker start <container>` for each name in `SONAR_CONTAINERS`, with a 60-second timeout per start.

On a timeout, devbox-mcp sends `SIGKILL` to the `docker run` process, runs `docker kill <name>`, and returns the output it has so far followed by `devbox-mcp: timed out after <n>s`. A `docker start` in the wake that passes its 60 seconds gets the `SIGKILL` alone.

At most `MAX_CONCURRENT_RUNS` of these containers run at once, across both tools. A call takes its slot just before `docker run` and frees it when the `docker run` process exits, after a timeout too. A call past the limit starts no container and gets `busy:`.

## Fixed limits

| Limit | Value | Where |
|---|---|---|
| output returned | the last 20,000 characters | `MAX_OUTPUT_CHARS`, [src/index.js](../../src/index.js) |
| `/work` tmpfs | `size=4g` | [src/index.js](../../src/index.js) |
| wake: time between rounds | 5 s | [src/sonar-wake.js](../../src/sonar-wake.js) |
| wake: status request timeout | 5 s | [src/sonar-wake.js](../../src/sonar-wake.js) |
| wake: `docker start` timeout | 60 s | [src/index.js](../../src/index.js) |
| gate: request timeout | 10 s | [src/sonar-gate.js](../../src/sonar-gate.js) |

## Development

| Command | What it does |
|---|---|
| `npm ci` | installs the dependencies in `package-lock.json` |
| `npm start` | runs `node src/index.js` |
| `npm test` | runs `node --test` over `test/` |

The 30 tests need `npm ci` first, and no Docker, SonarQube or network. Nine, in [test/index.test.js](../../test/index.test.js), start `src/index.js` on a free port with a stand-in `docker` script first on `PATH` and call it with the MCP SDK's client. The other 21 import `src/projects.js`, `src/toolchains.js`, `src/sonar-gate.js` and `src/sonar-wake.js`, which use nothing outside Node.js. The runtime dependencies are `@modelcontextprotocol/sdk`, `express` and `zod` ([package.json](../../package.json)).
