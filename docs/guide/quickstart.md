---
title: "Quickstart"
description: "Start devbox-mcp behind a docker-socket-proxy, list the projects it sees, and run one project's test suite over MCP."
order: 1
section: "Get started"
---

You start two containers on a Docker host: a docker-socket-proxy that opens only the sections of the Docker API devbox-mcp uses, and devbox-mcp itself. Then you call `list_projects` and `run_tests` with `curl`, and connect an MCP client.

## Prerequisites

- A Linux Docker host. The published image is built for `linux/amd64` only: [publish.yml](../../.github/workflows/publish.yml) sets no `platforms`.
- Your checkouts in one directory on that host, one per subdirectory. This page uses `/srv/repos`. The image runs as its `node` user ([Dockerfile](../../Dockerfile)), so that user needs read access.
- Outbound network from the host. Test runs pull toolchain images and restore packages.
- `curl` and `jq` for the calls on this page.

## Start a docker-socket-proxy

devbox-mcp launches containers through the Docker API. Give it a proxy scoped the way the [README](../../README.md#why-this-needs-a-docker-api-proxy-not-the-raw-socket) prescribes, never the socket itself:

```bash title="Start the proxy on its own network"
docker network create devbox
docker run -d --name docker-socket-proxy --network devbox \
  -e CONTAINERS=1 -e POST=1 -e IMAGES=1 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  tecnativa/docker-socket-proxy
```

`CONTAINERS` and `POST` let devbox-mcp create, start, wait for and remove containers and read their output, and `IMAGES` lets it pull toolchain images. The README leaves the rest off, so the proxy refuses `docker exec`, the network API and the volume API. Publish no port for the proxy: devbox-mcp reaches it over the `devbox` network. The proxy's own [README](https://github.com/Tecnativa/docker-socket-proxy) covers platform details. Pin the image you deploy.

## Start devbox-mcp

```bash title="Start devbox-mcp on the same network"
docker run -d --name devbox-mcp --network devbox \
  -p 127.0.0.1:8000:8000 \
  -e PROJECTS_ROOT=/srv/repos \
  -e DOCKER_HOST=tcp://docker-socket-proxy:2375 \
  -v /srv/repos:/srv/repos:ro \
  ghcr.io/egoushka/devbox-mcp:0.6.0
```

> [!IMPORTANT]
> Mount the checkouts at the path they have on the Docker host, and set `PROJECTS_ROOT` to that path. `run_tests` and `sonar_scan` hand `<PROJECTS_ROOT>/<project>` to `docker run -v` as the bind-mount source ([src/index.js](../../src/index.js)), and the Docker daemon looks that path up on the host, outside the devbox-mcp container. With two different paths, the test container gets the wrong directory, or an empty one that the daemon creates.

`-p 127.0.0.1:8000:8000` publishes the port on the host's loopback only. The server has no authentication, so bind it to a private address at most ([Security model](security-model.md#what-stays-exposed)).

Check that it is up:

```bash
curl -s http://127.0.0.1:8000/healthz
docker logs devbox-mcp
```

`/healthz` answers `ok`, and the log holds one line: `devbox-mcp listening on :8000, projects root /srv/repos`.

## List the projects

The server keeps no session: each request stands alone and needs no `initialize` first. A request has to accept both JSON and server-sent events, and the answer comes back as one `message` event.

```bash title="Call list_projects"
curl -s http://127.0.0.1:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}' \
  | sed -n 's/^data: //p' | jq -r '.result.content[0].text'
```

You get one entry per project:

```json
[
  {
    "name": "my-app",
    "type": "npm",
    "timeoutMs": 600000,
    "memory": "2g",
    "cpus": 2
  }
]
```

`type` is the detected toolchain, `dotnet`, `npm` or `pytest`, or `null` when no marker file matched. `timeoutMs`, `memory` and `cpus` are the limits `run_tests` applies to that project.

## Run one test suite

Pick a project whose `type` is not `null` and pass its name to `run_tests`:

```bash title="Call run_tests"
curl -s http://127.0.0.1:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_tests","arguments":{"project":"my-app"}}}' \
  | sed -n 's/^data: //p' | jq '{isError: .result.isError, output: .result.content[0].text}'
```

The call returns when the container exits, and the first run of a toolchain pulls its image before the tests start. `output` holds the last 20,000 characters of the run's stdout and stderr. `isError` is `false` only when the test command exited 0. For an npm project the command is `npm ci && npm test` in `node:20-slim`; [Run a test suite](run-tests.md#what-a-project-needs) covers each toolchain.

## Connect an MCP client

Point a client that speaks Streamable HTTP at `http://127.0.0.1:8000/mcp`. In Claude Code:

```bash
claude mcp add --transport http devbox http://127.0.0.1:8000/mcp
```

> [!IMPORTANT]
> Set your client's tool-call timeout above your slowest test suite. A client built on the MCP TypeScript SDK gives up on a call after 60 seconds by default and cancels it, and the server cannot stop the run: the test container goes on until its command ends or it reaches `timeoutMs`, and the client never sees the result ([Status](status.md#requests-during-a-tool-call)).

## Run from a clone instead

Outside Docker you need Node.js (the image uses 24) and the `docker` CLI on `PATH`. The server then needs an address for the proxy: start the proxy with `-p 127.0.0.1:2375:2375` as well to publish its port on the host's loopback, then:

```bash title="Run from a clone"
npm ci
PROJECTS_ROOT=/srv/repos DOCKER_HOST=tcp://127.0.0.1:2375 npm start
```

Without a `docker` CLI on `PATH`, each call that runs `docker` fails with an error that contains `could not run docker: spawn docker ENOENT` ([src/index.js](../../src/index.js)). The server listens on every interface: `app.listen(port)` names no host.

Next: [run a test suite](run-tests.md) or [scan with SonarQube](sonarqube.md).
