---
title: "Run a test suite"
description: "Prepare a project for run_tests, set its toolchain and limits in the projects file, read the result, and fix the usual failures."
order: 2
section: "Guides"
---

`run_tests` runs a project's own test command in a one-shot container and returns the output. You pick the project; its toolchain decides the image and the command.

## How the toolchain is chosen

devbox-mcp looks for marker files at the root of the checkout, in this order, and the first match wins ([src/toolchains.js](../../src/toolchains.js)):

| Toolchain | Marker at the root | Image |
|---|---|---|
| `dotnet` | a `.sln`, `.slnx` or `.csproj` file | `mcr.microsoft.com/dotnet/sdk:<major>.0` |
| `npm` | `package.json` | `node:20-slim` |
| `pytest` | `pyproject.toml` or `requirements.txt` | `python:3.12-slim` |

A checkout with a `.csproj` and a `package.json` counts as `dotnet`. To choose another toolchain, set `toolchain` for the project in the [projects file](#set-limits-in-the-projects-file). A checkout with no marker shows `"type": null` in `list_projects`, and `run_tests` refuses it.

## What a project needs

Each command copies the checkout from `/repo` to `/work` and runs there. The [reference](reference.md#toolchains) has the exact commands.

### npm

The command is `npm ci && npm test`. `npm ci` installs from the lockfile, so the checkout needs a `package-lock.json` and a `test` script. It runs on `node:20-slim`, whatever the project's `engines` field asks for.

### pytest

The command installs `requirements.txt` when the checkout has one, then runs `pytest -q` on `python:3.12-slim`. It installs nothing else, so a dependency that only `pyproject.toml` declares never reaches the container, and neither does pytest unless `requirements.txt` lists it. List pytest and your test dependencies in `requirements.txt`.

### dotnet

The command is `dotnet test --nologo` at the root, with no project argument, so the root must hold a single solution or project file for `dotnet test` to find. The SDK image follows `sdk.version` in `global.json`: `10.0.100` gives `sdk:10.0`. Without a `global.json`, or with a version that does not start with `major.minor.patch` in digits, the image is `sdk:8.0` ([test/toolchains.test.js](../../test/toolchains.test.js)). An SDK image carries only its own runtime, so a project that targets another .NET version needs a `global.json` that names its SDK.

## Set limits in the projects file

Without `PROJECTS_FILE`, every directory under `PROJECTS_ROOT` is a project, and each gets the defaults: `RUN_TIMEOUT_MS` (10 minutes unless you set it), memory `2g` and `2` CPUs. With it, only the projects the file names are listed and runnable, and each can override its toolchain and limits ([src/projects.js](../../src/projects.js)):

```json title="projects.json"
{
  "projects": {
    "my-api": { "timeoutMs": 900000 },
    "my-web": { "toolchain": "npm", "memory": "3g", "cpus": 1.5 },
    "my-lib": {}
  }
}
```

| Key | Value | Overrides |
|---|---|---|
| `toolchain` | `dotnet`, `npm` or `pytest` | detection |
| `timeoutMs` | a positive integer, in milliseconds | `RUN_TIMEOUT_MS` |
| `memory` | a Docker size such as `2g` or `1536m` | `2g` |
| `cpus` | a number above 0, at most 16 | `2` |

devbox-mcp reads the file on every call, so an edit applies without a restart. A missing or malformed file fails every call instead of falling back to listing everything, and a bad entry names its problem, such as `projects file: "my-web": unknown key "image"` ([test/projects.test.js](../../test/projects.test.js)). A project the file names without a directory under `PROJECTS_ROOT` stays out of the list.

> [!TIP]
> Mount the directory that holds the file, not the file itself: a single-file bind mount keeps the old inode after a `git pull` replaces the file ([README](../../README.md#allowlist-and-per-project-limits)).

The limits apply to `run_tests` only. `sonar_scan` always runs with `2g`, 2 CPUs and `RUN_TIMEOUT_MS`.

## Call it and read the result

Call `list_projects`, then `run_tests` with a `name` from its answer:

```json title="tools/call params"
{ "name": "run_tests", "arguments": { "project": "my-api" } }
```

The call returns when the container exits:

- The text is the last 20,000 characters of stdout and stderr together, so a long log loses its beginning.
- `isError` is `true` when the command exits non-zero. A failed restore and a failed test look the same from outside, so read the output.
- devbox-mcp names the container `devbox-run-<uuid>`, and Docker removes it when it exits (`--rm`).
- At most `MAX_CONCURRENT_RUNS` runs go at once, 1 unless you set it, counting `sonar_scan`. A call past that returns at once with `busy:` and the runs in progress ([Status](status.md#a-cap-on-concurrent-runs)).

> [!NOTE]
> Set the client's timeout above the project's `timeoutMs`. When the client times a call out first, the run goes on, cancelled or not: the container runs until it exits or reaches `timeoutMs`, and the client never sees the result ([Status](status.md#requests-during-a-tool-call)). The run holds its slot meanwhile, so a retry gets `busy:`.

## When it fails

| What you see | Cause | Fix |
|---|---|---|
| `unknown project "<name>" — call list_projects first` | the name is not in the list | use a `name` from `list_projects` |
| `no supported toolchain detected for "<name>"` | no marker at the root | set `toolchain` in the projects file |
| `projects file: ...`, `ENOENT`, or a JSON error | a missing or invalid projects file | fix the file |
| an error result that ends with `devbox-mcp: timed out after <n>s` | the run reached `timeoutMs` | raise `timeoutMs` |
| `could not run docker: spawn docker ENOENT` | no `docker` CLI on the server's `PATH` | run the image, or install the CLI |
| `busy: run_tests <name> (<n>s) already running, ...` | `MAX_CONCURRENT_RUNS` runs are in progress | call again when one finishes, or raise `MAX_CONCURRENT_RUNS` |
| `npm ci` complains about the lockfile | no usable `package-lock.json` | commit one |
| `pytest: not found` | pytest is not in `requirements.txt` | add it |
| the tests find no project files | `PROJECTS_ROOT` differs on the host | [mount at the same path](quickstart.md#start-devbox-mcp) |

A directory can be missing from `list_projects` for three reasons: it is a symbolic link, since only real directories count; the projects file does not name it; or the file names it and the directory does not exist.

On a timeout, devbox-mcp kills the `docker run` client with `SIGKILL`, runs `docker kill` on the container's name, and returns what it has read with `devbox-mcp: timed out after <n>s` at the end (`runContainer` in [src/index.js](../../src/index.js)). Docker keeps a container running after its client dies; the `docker kill` stops it, and `--rm` removes it. If `docker kill` fails, the container runs until its command ends, and `docker ps --filter name=devbox-run-` lists it.
