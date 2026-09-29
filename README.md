# devbox-mcp

MCP server that lets an LLM run a project's *real* test suite, and a
SonarQube scan, against projects it can see on disk — without giving the LLM
a raw shell.

Tools:

- `list_projects` — lists directories under `PROJECTS_ROOT`, detected
  toolchain (`dotnet` / `npm` / `pytest` / none).
- `run_tests(project)` — runs that project's test suite in a throwaway,
  one-shot container: the repo is bind-mounted **read-only**, a tmpfs
  provides writable scratch space, and the container is removed after.
  `project` must be a name `list_projects` returned — this is the only
  guard against a path-traversal or prompt-injected argument escaping
  `PROJECTS_ROOT`.
- `sonar_scan(project)` — runs `sonar-scanner-cli` against the project
  (requires a `sonar-project.properties` file in it) and your SonarQube
  server. If SonarQube runs on demand (stopped when idle), it first
  `docker start`s the containers in `SONAR_CONTAINERS`, in order, and polls
  `/api/system/status` until `UP`; a running container is a no-op.

## Why this needs a Docker API proxy, not the raw socket

`run_tests` and `sonar_scan` need to launch containers, which normally means
mounting `/var/run/docker.sock`. **Don't do that.** A mounted Docker socket
is root on the host — anyone who can make this server run an arbitrary
command (a malicious test file, a prompt-injected tool argument) can then
talk to the Docker API directly and do anything root can do.

Put [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
in front of the real socket instead, and point this server's `DOCKER_HOST`
at the proxy. Scope the proxy to only what's needed:

```yaml
environment:
  CONTAINERS: 1   # create/start/wait/logs/remove containers
  POST: 1         # without this, the proxy is read-only
  IMAGES: 1       # pull the toolchain images
  # everything else defaults to 0/off: no EXEC, no NETWORKS, no VOLUMES.
```

`CONTAINERS` + `POST` also let this server start existing containers by
name, which `sonar_scan` uses to wake SonarQube.

This is a real narrowing (no `docker exec` into unrelated containers, no
host-network access, no volume mounts beyond what this server's own `docker
run` calls specify), not a sandbox: a compromised instance can still launch
containers on your host. Treat it accordingly — this is not something to
expose beyond a private network.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PROJECTS_ROOT` | `/srv/chargehand/repos` | Directory of project checkouts to operate on |
| `DOCKER_HOST` | (docker default) | Point at your docker-socket-proxy, e.g. `tcp://docker-socket-proxy:2375` |
| `SONAR_HOST_URL` | — | Your SonarQube server, reachable **by address**, not by a Docker Compose service name — the scan runs in its own one-shot container on the default bridge network, not your SonarQube stack's network |
| `SONAR_TOKEN` | — | SonarQube user/analysis token |
| `SONAR_CONTAINERS` | `sonarqube-db-1,sonarqube-sonarqube-1` | Containers `sonar_scan` starts, in this order, before scanning. Set it empty to skip the wake when SonarQube is always on or not in this Docker host |
| `SONAR_WAKE_TIMEOUT_MS` | `180000` | How long `sonar_scan` waits for SonarQube to report `UP` before failing |
| `RUN_TIMEOUT_MS` | `600000` | Kill switch per container run |
| `PORT` | `8000` | HTTP port (Streamable HTTP MCP transport, path `/mcp`) |

## Running

```bash
docker run -p 8000:8000 \
  -e PROJECTS_ROOT=/repos \
  -e DOCKER_HOST=tcp://docker-socket-proxy:2375 \
  -e SONAR_HOST_URL=http://your-sonarqube:9000 \
  -e SONAR_TOKEN=... \
  -v /path/to/your/repos:/repos:ro \
  ghcr.io/egoushka/devbox-mcp:latest
```

Pin an exact tag/digest in production — `latest` is for trying it out.

## Scope / non-goals (v1)

No arbitrary path execution (only `list_projects`-returned names), no write
access to the mounted repos, no auto-remediation, no CI trigger integration.
Toolchains supported: dotnet, npm, pytest — pull requests welcome for more.
A dotnet project is one with a `.sln`, `.slnx` or `.csproj` at its root; its
tests run in `mcr.microsoft.com/dotnet/sdk:<major>.0`, the major taken from
`global.json`'s `sdk.version` (`8.0` without one), because an SDK image only
carries its own runtime.

## License

MIT
