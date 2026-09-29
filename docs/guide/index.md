---
title: "Overview"
description: "What devbox-mcp is, how a tool call runs, what it leaves out, and where version 0.5.0 stands."
order: 0
section: "Get started"
---

devbox-mcp is an MCP server that lets an assistant run a project's real test suite and a SonarQube scan without handing it a shell or the Docker socket. The assistant names a project. devbox-mcp builds the `docker run` command itself, runs it in a throwaway container, and returns the output.

The server is JavaScript on Node.js and the MCP TypeScript SDK, and it serves MCP over Streamable HTTP at `POST /mcp` ([src/index.js](../../src/index.js)). You run it on a Docker host you control, next to the checkouts you want an assistant to test.

## How a call works

1. **The assistant lists projects.** `list_projects` returns each directory under `PROJECTS_ROOT`, or each one the projects file names, with its detected toolchain and its `run_tests` limits ([src/projects.js](../../src/projects.js)).
2. **It names one.** `run_tests`, `sonar_scan` and `sonar_quality_gate` take one argument, `project`, and refuse any name that `list_projects` does not return. That lookup keeps a `../` argument, or one a prompt injection wrote, inside `PROJECTS_ROOT` (`resolveProject` in [src/index.js](../../src/index.js)).
3. **devbox-mcp starts a one-shot container.** Its docker CLI sends each Docker API call to `DOCKER_HOST`, which should be a docker-socket-proxy. The container gets the checkout read-only and runs the toolchain's test command on a copy in a tmpfs, and Docker removes it when it exits.
4. **The assistant reads the result.** It gets the last 20,000 characters of stdout and stderr as text, flagged as an error when the command exits non-zero.

For SonarQube, `sonar_scan` first starts the SonarQube containers if they are stopped and waits until the server reports `UP` ([src/sonar-wake.js](../../src/sonar-wake.js)). SonarQube finishes the analysis after the scan returns, so `sonar_quality_gate` reads the gate in a separate call and reports whether an analysis is still pending ([src/sonar-gate.js](../../src/sonar-gate.js)).

## The four tools

| Tool | Input | What it does |
|---|---|---|
| `list_projects` | none | lists projects, toolchains and limits |
| `run_tests` | `project` | runs the test suite in a throwaway container |
| `sonar_scan` | `project` | wakes SonarQube and runs `sonar-scanner-cli` |
| `sonar_quality_gate` | `project` | reads the gate of the latest analysis |

The [reference](reference.md#tools) gives each tool's output and error texts.

## What it does not do

The README lists four non-goals: no arbitrary path execution, no write access to the mounted repositories, no auto-remediation, and no CI trigger integration ([README](../../README.md#scope--non-goals-v1)). The code sets these limits too:

- **Three toolchains.** dotnet, npm and pytest, detected by marker file ([src/toolchains.js](../../src/toolchains.js)). A project with none of the markers gets `no supported toolchain detected`.
- **A project name and nothing else.** The assistant cannot pass a command, a path, an image, a Docker flag or an environment variable.
- **No authentication.** Any client that reaches the port can call every tool. The README says to keep the server on a private network.
- **No stdio transport.** The server speaks Streamable HTTP only.
- **No network isolation for test runs.** Package restore needs a registry, so test containers keep outbound network access (the comment on the `run_tests` handler in [src/index.js](../../src/index.js)).

## Current status

- **Version 0.5.0**, the latest tag. A push to `main` publishes the image `ghcr.io/egoushka/devbox-mcp:latest`, and each tag publishes its version, such as `0.5.0` ([publish.yml](../../.github/workflows/publish.yml)).
- **Tested in parts.** 21 tests cover toolchain detection, the projects file, the SonarQube wake and the gate reader. No test covers [src/index.js](../../src/index.js): the tool handlers, the `docker run` arguments and the HTTP transport.
- **One request at a time.** A request that reaches the server while a tool call runs crashes the process. A client that cancels a call it timed out sends such a request ([Status](status.md#one-request-at-a-time)).

## Where to go next

- [Quickstart](quickstart.md): the image behind a docker-socket-proxy, and one project's tests.
- [Run a test suite](run-tests.md): what a project needs, its limits, and the usual failures.
- [Scan with SonarQube](sonarqube.md): configuration, the scan, and polling the gate.
- [Security model](security-model.md): what the assistant can and cannot reach.
- [Reference](reference.md): tools, endpoints, environment variables and the projects file.
- [Status](status.md): what works, what is partial, what is missing.
