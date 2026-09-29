---
title: "Status"
description: "What works, what is partial and what is not built in devbox-mcp 0.7.0, with the test or file behind each, and the releases so far."
order: 6
section: "Project"
---

Each row names its evidence. `works` means a test in this repository covers it. `partial` means part of it is missing, or the code does it and no test covers it. `not yet` means it does not exist. This page describes version 0.7.0.

The 30 tests run with `npm test` after `npm ci`, and need no Docker, SonarQube or network. The detection and projects-file tests build temporary directories, and the SonarQube tests pass in stand-ins for `docker`, `fetch` and the clock. The server tests start [src/index.js](../../src/index.js) on a free local port with a stand-in `docker` script first on `PATH`, and call it through the MCP SDK's client. No workflow runs them. [publish.yml](../../.github/workflows/publish.yml), the only workflow, builds and pushes the image and has no test step.

## Summary

| Capability | Status | Evidence |
|---|---|---|
| [Toolchain detection](#toolchain-detection) | works | [toolchains.test.js](../../test/toolchains.test.js) |
| [.NET SDK image from `global.json`](#net-sdk-image-from-globaljson) | works | [toolchains.test.js](../../test/toolchains.test.js) |
| [Projects file](#projects-file) | works | [projects.test.js](../../test/projects.test.js) |
| [Waking SonarQube](#waking-sonarqube) | works | [sonar-wake.test.js](../../test/sonar-wake.test.js) |
| [Reading the quality gate](#reading-the-quality-gate) | works | [sonar-gate.test.js](../../test/sonar-gate.test.js) |
| [Requests during a tool call](#requests-during-a-tool-call) | works | [index.test.js](../../test/index.test.js) |
| [A cap on concurrent runs](#a-cap-on-concurrent-runs) | works | [index.test.js](../../test/index.test.js) |
| [`run_tests` in a one-shot container](#run_tests-in-a-one-shot-container) | partial | [index.test.js](../../test/index.test.js) |
| [Names limited to `list_projects`](#names-limited-to-list_projects) | partial | [src/index.js](../../src/index.js) |
| [`sonar_scan`](#sonar_scan) | partial | [src/index.js](../../src/index.js) |
| [Container image](#container-image) | partial | [publish.yml](../../.github/workflows/publish.yml) |
| [Authentication](#authentication) | not yet | [src/index.js](../../src/index.js) |
| [Network isolation for test runs](#network-isolation-for-test-runs) | not yet | [src/index.js](../../src/index.js) |
| [Images pinned by digest](#images-pinned-by-digest) | not yet | [src/toolchains.js](../../src/toolchains.js) |
| [Other toolchains](#other-toolchains) | not yet | [README](../../README.md#scope--non-goals-v1) |
| [Tests in CI](#tests-in-ci) | not yet | [publish.yml](../../.github/workflows/publish.yml) |

## What works

### Toolchain detection

[test/toolchains.test.js](../../test/toolchains.test.js) checks that a `.slnx`, `.sln` or `.csproj` detects as `dotnet` and that a checkout with no marker has no toolchain. [test/projects.test.js](../../test/projects.test.js) sees `package.json` detect as `npm`. The pytest markers have no test of their own.

### .NET SDK image from global.json

[test/toolchains.test.js](../../test/toolchains.test.js): `10.0.100` gives `sdk:10.0`; a missing file, a file that is not JSON, or one without `sdk.version` gives `sdk:8.0`; a version that is not digits never reaches the image tag. Commit `dc4cd87` (#12) gives the reason: an SDK image carries only its own runtime, so `sdk:8.0` cannot run a `net10.0` test project.

### Projects file

[test/projects.test.js](../../test/projects.test.js) covers six cases. Without a file, every directory is a project. With one, only the listed projects come back, and a listed project with no checkout drops out. Per-project keys override the defaults and detection. A missing or malformed file refuses instead of listing everything. Entries fail validation before any value reaches `docker run`, including `../etc`, `"2g --privileged"`, an unknown key and the toolchain name `constructor`.

### Waking SonarQube

[test/sonar-wake.test.js](../../test/sonar-wake.test.js) drives the loop with a fake Docker, `fetch` and clock. A server already `UP` gets one start per container, database first. A cold start polls through a refused connection and `STARTING`, repeating the starts each round. A server that never reaches `UP` fails after 180 seconds and 37 polls, naming the last status. A failing `docker start` fails at once with Docker's output.

### Reading the quality gate

[test/sonar-gate.test.js](../../test/sonar-gate.test.js) runs against a fake SonarQube. The project key comes from `sonar-project.properties` in any separator style, and a commented-out key does not count. The result carries the gate, its conditions and the analysis it describes; a queued analysis reads as `pending`; SonarQube's own error message comes through; a refused token says what kind of token the gate needs. The tool handler that calls this code has no test.

### Requests during a tool call

Each `POST /mcp` gets its own `McpServer` and transport ([src/index.js](../../src/index.js)), so the server answers a request that arrives while a tool call runs. [test/index.test.js](../../test/index.test.js) holds a `run_tests` call open in a stand-in `docker`: a `tools/list` sent during the call gets its answer, and the call still returns its output. A client whose call times out posts `notifications/cancelled`, gets `202`, and goes on calling tools.

The cancellation stops nothing. The server keeps no session, so the `McpServer` that receives the notification has no such call: the container runs until it exits or reaches its timeout, and its answer reaches a client that has given up. The same test waits for that late answer. Up to 0.5.0 the requests shared one `McpServer`, and any request during a tool call ended the process with `Already connected to a transport`.

### A cap on concurrent runs

At most `MAX_CONCURRENT_RUNS` `run_tests` and `sonar_scan` containers run at once, 1 unless you set it ([src/index.js](../../src/index.js)). A call past the limit gets an error that starts `busy:` and names each run in progress with its age. Nothing queues: a stateless server could not cancel a queued call whose client gave up, so the call would still run, for nobody. A run keeps its slot until its container exits, a cancelled run included, so a retry after a client timeout gets `busy:` instead of starting a second copy.

[test/index.test.js](../../test/index.test.js) checks the refusal and a freed slot taking the next call, two runs at once with `MAX_CONCURRENT_RUNS=2`, a `sonar_scan` holding a slot, a full cap refusing `sonar_scan` before its wake, a failed run giving its slot back, and a value that is not a whole number above 0 stopping the server at startup.

## What is partial

### run_tests in a one-shot container

The detection and limits that `run_tests` relies on have tests. [test/index.test.js](../../test/index.test.js) runs the handler against a stand-in `docker`: the result carries the command's output, a missing `docker` CLI gives an error result, and a run that reaches its timeout ends with `docker kill` on its container and a line that says so. No test checks the `docker run` arguments or starts a real container. The commands leave gaps too: the pytest command installs only `requirements.txt`, the npm command always runs Node.js 20, and the dotnet command names no solution ([Run a test suite](run-tests.md#what-a-project-needs)).

### Names limited to list_projects

`resolveProject` in [src/index.js](../../src/index.js) accepts only a `name` from the current `list_projects` output, then checks that the joined path stays under `PROJECTS_ROOT`. No test sends it an unknown name or a `../` path; [test/index.test.js](../../test/index.test.js) calls it with a listed one only. [test/projects.test.js](../../test/projects.test.js) covers the projects file's side: `../etc` is not a plain directory name.

### sonar_scan

The wake has tests, and [test/index.test.js](../../test/index.test.js) runs the tool against a stand-in `docker` for the run cap. No test checks the scanner's arguments or runs the real scanner, and the repository records no scan that completed through `sonar_scan`. The scanner sees the checkout read-only, which matters for SonarScanner's working directory ([Scan with SonarQube](sonarqube.md#prepare-the-project)). The scan always runs with `2g`, 2 CPUs, `RUN_TIMEOUT_MS` and the `latest` scanner image.

### Container image

[publish.yml](../../.github/workflows/publish.yml) builds and pushes the image on every push to `main`, as `latest`, and on every `v*` tag, as the version without the `v`. It sets no `platforms`, so the image is `linux/amd64` only. Its actions are pinned to commit SHAs, and [dependabot.yml](../../.github/dependabot.yml) updates them, the npm dependencies and the base image weekly. No workflow starts the image. The message of commit `90b4f5d` (#10) records one check by hand: a built image answered `/healthz` on Node.js 24.21.0.

## What is missing

### Authentication

[src/index.js](../../src/index.js) checks no credentials on `/mcp`. The README's answer is to keep the server on a private network.

### Network isolation for test runs

Test containers keep Docker's default network. The comment on the `run_tests` handler in [src/index.js](../../src/index.js) explains that package restore needs a registry, and names an egress-only proxy as the way to narrow it if that becomes a problem.

### Images pinned by digest

The toolchain images in [src/toolchains.js](../../src/toolchains.js) and the scanner image in [src/index.js](../../src/index.js) are tags. The comment in `src/toolchains.js` says the repository names the toolchain and does not vet supply-chain trust. No setting overrides an image.

### Other toolchains

dotnet, npm and pytest are the only runners. The README invites pull requests for more ([README](../../README.md#scope--non-goals-v1)).

### Tests in CI

[publish.yml](../../.github/workflows/publish.yml) is the only workflow, and it runs no tests. The tests run when someone types `npm test`.

## Releases

| Tag | Commit | Added |
|---|---|---|
| `v0.1.0` | `86c933e` | `list_projects`, `run_tests`, `sonar_scan`, `/healthz` |
| `v0.2.0` | `7fe7908` | SonarQube wake; Node.js 24 image built from the lockfile |
| `v0.3.0` | `dc4cd87` | `.slnx` detection; .NET SDK image from `global.json` |
| `v0.4.0` | `8acc271` | `PROJECTS_FILE` with per-project limits |
| `v0.5.0` | `68457ed` | `sonar_quality_gate` |
| `v0.6.0` | `703ae27` | requests during a tool call; `docker kill` on timeout |
| `v0.7.0` | `32c9828` | a cap on concurrent runs, `MAX_CONCURRENT_RUNS` |

`v0.2.0` also brought SHA-pinned actions, Dependabot and SECURITY.md (#1). There is no changelog: the tags and their commit messages are the record. Each tag's image is `ghcr.io/egoushka/devbox-mcp:<version>`, and [SECURITY.md](../../SECURITY.md#supported-versions) supports only the latest image tag and the latest commit on `main`.
