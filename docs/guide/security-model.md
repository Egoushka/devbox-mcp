---
title: "Security model"
description: "What an assistant can and cannot reach through devbox-mcp, why it gets no shell and no Docker socket, and what stays exposed."
order: 4
section: "Concepts"
---

devbox-mcp lets an assistant execute a project's tests and nothing else of its choosing. This page follows a call across each boundary and names the code that holds it.

## The path of a call

```text
assistant ── MCP client ── POST /mcp ──> devbox-mcp
                                           │  reads PROJECTS_ROOT through a read-only mount
                                           │  runs the docker CLI against DOCKER_HOST
                                           ▼
                                   docker-socket-proxy ──> Docker daemon
                                                              │
                                  one container per run_tests or sonar_scan call:
                                  checkout mounted read-only, removed on exit
```

The assistant talks to devbox-mcp only. devbox-mcp reaches the Docker API only through the proxy, and project code runs only inside the container.

## What the assistant controls

The assistant picks a tool and, for three of the four tools, one string: `project`. The handlers read nothing else from the call ([src/index.js](../../src/index.js)).

`project` has to equal a `name` in the list that `list_projects` builds at that moment. `resolveProject` looks the name up, then checks that `PROJECTS_ROOT` joined with it stays under `PROJECTS_ROOT`. The list holds real directories only, so a symbolic link under the root never becomes a project, and a projects file may name only plain directory names that match `^[A-Za-z0-9][A-Za-z0-9._-]*$` ([src/projects.js](../../src/projects.js)).

devbox-mcp then spawns `docker` with an argument array and no shell, so nothing passes through a shell on its side. The image and the `sh -c` command inside the container are fixed per toolchain in [src/toolchains.js](../../src/toolchains.js). The parts that vary never come from the assistant:

| Part | Comes from | Checked by |
|---|---|---|
| bind-mount source | `PROJECTS_ROOT` and the listed name | the lookup above |
| container name | a random UUID | nothing needed |
| toolchain | detection, or the projects file | must be `dotnet`, `npm` or `pytest` |
| memory, CPUs, timeout | the projects file, or the defaults | validated before `docker run` |
| .NET image tag | `sdk.version` in `global.json` | digits only, else `8.0` |

[test/projects.test.js](../../test/projects.test.js) rejects values such as `"2g --privileged"` for `memory`, and [test/toolchains.test.js](../../test/toolchains.test.js) keeps a version of `"latest; rm -rf /"` out of the image tag.

## What runs inside the container

`run_tests` runs the project's own test command, and a test suite is code. devbox-mcp runs whatever the checkout holds when the call arrives, so anything that can write to a checkout under `PROJECTS_ROOT` decides what `run_tests` executes: a `git pull`, or another tool that edits files.

Inside the container, test code can:

- read the whole checkout, which devbox-mcp mounts at `/repo` and copies to `/work`
- write to `/work`, a 4 GB tmpfs that disappears with the container
- reach the network, because devbox-mcp leaves Docker's default network in place for package restore
- use the project's memory and CPU limits until its timeout

It cannot:

- write to the checkout, because the mount is read-only
- read devbox-mcp's environment: `run_tests` passes no `-e`, so `SONAR_TOKEN` never enters a test container
- reach the Docker API through a mount: devbox-mcp mounts no socket and sets no `DOCKER_HOST` in the container

The network is the open edge. Keep the proxy on a network that only devbox-mcp joins, with no published port, as the [quickstart](quickstart.md#start-a-docker-socket-proxy) does.

## Why no shell and no socket

A shell tool would hand the assistant, and any prompt injection that reaches it, every command the server's user can run. devbox-mcp offers four fixed verbs, and its only free input is a name it checks against a list.

The Docker socket is the same problem one level down. The README's reason: a mounted socket is root on the host, so anything that can make the server run a command, such as a malicious test file or a prompt-injected argument, could drive the Docker API directly ([README](../../README.md#why-this-needs-a-docker-api-proxy-not-the-raw-socket)). devbox-mcp holds no socket at all. It uses the docker CLI from its image, pointed at `DOCKER_HOST`, and the image runs as the `node` user ([Dockerfile](../../Dockerfile)).

## What the proxy limits

With the README's settings, the proxy opens the container and image sections of the Docker API and allows `POST`. The sections the README leaves off stay closed, among them `exec`, networks and volumes ([README](../../README.md#why-this-needs-a-docker-api-proxy-not-the-raw-socket)).

The proxy decides by API section and method. It does not read the body of a container-create request, so it cannot tell a toolchain container from one that asks for a host mount, host networking or privileges. devbox-mcp's own arguments ask for none of them (see [Containers](reference.md#containers)). A compromised devbox-mcp could ask for all of them. The README calls the proxy "a real narrowing" and "not a sandbox" for that reason: it removes whole classes of calls, and the rest of the protection rests on devbox-mcp's code.

## What stays exposed

- **No authentication.** [src/index.js](../../src/index.js) checks no credentials, and `app.listen(port)` binds every interface. Any client that reaches the port can run the tests of every listed project and read their output. Keep the port on loopback or a private network, as the README says.
- **Outbound network from test code.** A malicious test can send the checkout anywhere its container can reach.
- **Images by tag.** The toolchain images and `sonarsource/sonar-scanner-cli:latest` are tags, not digests. The comment in [src/toolchains.js](../../src/toolchains.js) says the repository names the toolchain and leaves supply-chain vetting to you, and no setting changes an image.
- **The SonarQube token on a command line.** `sonar_scan` passes `-e SONAR_TOKEN=<token>` as a `docker run` argument, so the token shows in the process list, inside the devbox-mcp container and on its host, while a scan runs. It also sits in the scanner container's environment.
- **Test output reaches the assistant.** Whatever the tests print, up to the last 20,000 characters, lands in the assistant's context.
- **Availability.** devbox-mcp runs at most `MAX_CONCURRENT_RUNS` `run_tests` and `sonar_scan` containers at once, 1 unless you set it, and refuses a call past that ([Status](status.md#a-cap-on-concurrent-runs)). A call that a client cancels keeps its container and its slot until the command ends or times out, so one client can hold the only slot for up to the project's `timeoutMs`, and every other call gets `busy:` until then.

## Reporting a vulnerability

[SECURITY.md](../../SECURITY.md) asks for GitHub private vulnerability reporting and names what to report: a tool argument that escapes `PROJECTS_ROOT`, a run that gets write access to a mounted repository, or a call that reaches a Docker API endpoint beyond what `run_tests` and `sonar_scan` need.
