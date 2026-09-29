---
title: "Scan with SonarQube"
description: "Point devbox-mcp at your SonarQube, scan a project with sonar_scan, and poll sonar_quality_gate until SonarQube has processed the analysis."
order: 3
section: "Guides"
---

`sonar_scan` runs `sonar-scanner-cli` against a project and your SonarQube server. `sonar_quality_gate` then reads the quality gate of the project's latest analysis. Both start SonarQube's containers first if they are stopped.

## Configure the server

| Variable | Default | Set it to |
|---|---|---|
| `SONAR_HOST_URL` | none | your SonarQube's URL, by address |
| `SONAR_TOKEN` | none | a token the scan and the web API accept |
| `SONAR_CONTAINERS` | `sonarqube-db-1,sonarqube-sonarqube-1` | the containers to start, in order |
| `SONAR_WAKE_TIMEOUT_MS` | `180000` | how long to wait for `UP` |

Both tools fail with `SONAR_HOST_URL / SONAR_TOKEN not configured` until you set the first two ([src/index.js](../../src/index.js)).

`SONAR_HOST_URL` has to work from two places. devbox-mcp uses it to check the server's status and read the gate, and the scanner container uses it from Docker's default bridge network. A Docker Compose service name does not resolve there, so give an address ([README](../../README.md#configuration)).

`SONAR_TOKEN` serves both tools. The scanner submits the analysis with it, and `sonar_quality_gate` sends it to the web API as `Authorization: Bearer <token>`. The [README](../../README.md) notes that SonarQube documents the web API for user tokens (Browse on the project), while analysis tokens are meant for running scans. When the gate read gets a 401 or 403, the error says which kind of token it needs.

## Prepare the project

Put a `sonar-project.properties` at the root of the checkout. The scanner reads its settings from it, and `sonar_quality_gate` reads `sonar.projectKey` from it ([src/sonar-gate.js](../../src/sonar-gate.js)):

```ini title="sonar-project.properties"
sonar.projectKey=my-api
sonar.sources=src
```

The key line may use `key=value`, `key: value` or `key value`, and a line that starts with `#` or `!` is a comment (`projectKeyFrom` in [src/sonar-gate.js](../../src/sonar-gate.js), [test/sonar-gate.test.js](../../test/sonar-gate.test.js)).

> [!NOTE]
> The scanner container sees the checkout read-only at `/usr/src`; the rest of its filesystem is writable. SonarScanner writes its working directory, `.scannerwork` by default, under the project directory. The repository records no scan that completed this way, so check the first scan's output. If it fails to write there, point `sonar.working.directory` at a writable location.

## Scan

Call `sonar_scan` with a project name from `list_projects`. It runs three steps:

1. The checks: both variables set, the project known, `sonar-project.properties` present.
2. The wake, unless `SONAR_CONTAINERS` is empty ([how it works](#how-the-wake-works)).
3. `docker run --rm --memory=2g --cpus=2` of `sonarsource/sonar-scanner-cli:latest`, with the checkout at `/usr/src:ro` and `SONAR_HOST_URL` and `SONAR_TOKEN` in its environment.

The text of the result is the scanner's output, the last 20,000 characters, and `isError` is `true` when the scanner exits non-zero. The scan uses `RUN_TIMEOUT_MS`; the projects file's limits do not apply to it. It counts against `MAX_CONCURRENT_RUNS` like a `run_tests` call: when the limit is reached, the call returns `busy:` before the wake, and again after it if another run started meanwhile ([Status](status.md#a-cap-on-concurrent-runs)).

## Read the quality gate

The scanner uploads a report and exits, and SonarQube's compute engine processes it afterwards. A gate read right after `sonar_scan` can still describe the previous analysis, so `sonar_quality_gate` says which analysis it read ([src/sonar-gate.js](../../src/sonar-gate.js)). The text of a result, with the condition from [test/sonar-gate.test.js](../../test/sonar-gate.test.js):

```json title="sonar_quality_gate result"
{
  "projectKey": "my-api",
  "status": "ERROR",
  "pending": false,
  "lastTask": {
    "status": "SUCCESS",
    "submittedAt": "<time>",
    "executedAt": "<time>"
  },
  "conditions": [
    {
      "metric": "new_coverage",
      "status": "ERROR",
      "actual": "41.2",
      "comparator": "LT",
      "threshold": "80"
    }
  ]
}
```

- `pending` is `true` while SonarQube has a task for the project queued or running. Call again later: nothing polls for you, and the next call is the poll.
- `lastTask` is the latest task SonarQube finished for the project, or `null` when there is none.
- `status` is the gate status SonarQube returns, such as `OK` or `ERROR`, and `NONE` when it gives none.
- `conditions` copies each condition in SonarQube's answer, whatever its `status`.

The tool reads `/api/ce/component` and `/api/qualitygates/project_status`, each with a 10-second timeout.

## How the wake works

The wake serves a SonarQube whose containers stop when idle; [src/sonar-wake.js](../../src/sonar-wake.js) was written for one that stops after 20 idle minutes. Each round runs `docker start` on every container in `SONAR_CONTAINERS`, in list order (the default starts the database before the server), then asks `/api/system/status`. The wake returns once the status is `UP`, and otherwise waits 5 seconds and runs another round. It repeats the starts every round, in case an idle stop lands between two polls.

- `docker start` on a running container changes nothing, so an always-on SonarQube costs the no-op starts and one status request per call.
- A failing `docker start` fails the call at once with Docker's output ([test/sonar-wake.test.js](../../test/sonar-wake.test.js)).
- After `SONAR_WAKE_TIMEOUT_MS`, the call fails with the last status it saw, such as `SonarQube at <url> not UP after 180s (last: status STARTING)`.
- Nothing stops SonarQube again. Its own idle stop does that.

The comment on `SONAR_WAKE_TIMEOUT_MS` in [src/index.js](../../src/index.js) records a cold start of 33 seconds to `UP`. Set `SONAR_CONTAINERS` to an empty string when SonarQube is always on or runs on another Docker host. The starts need `CONTAINERS` and `POST` in the proxy ([README](../../README.md#why-this-needs-a-docker-api-proxy-not-the-raw-socket)).

## When it fails

| Error text | What to do |
|---|---|
| `SONAR_HOST_URL / SONAR_TOKEN not configured` | set both variables |
| `no sonar-project.properties in "<name>"` | add the file at the checkout's root |
| `no sonar.projectKey in "<name>"'s sonar-project.properties` | add the key line |
| `docker start <container> failed: ...` | fix `SONAR_CONTAINERS`, or set it empty |
| `SonarQube at <url> not UP after <n>s ...` | check the server, or raise the timeout |
| `SonarQube /api/...: ... (reading the gate needs ...)` | use a token allowed to call the web API |
| scanner output that ends with `devbox-mcp: timed out after <n>s` | raise `RUN_TIMEOUT_MS`, or find what stalls the scan |
| `busy: ... already running, the limit of <n> (MAX_CONCURRENT_RUNS); ...` | call again when the run finishes, or raise `MAX_CONCURRENT_RUNS` |

As with `run_tests`, a scan that a client cancels runs on, holding its slot, until it exits or reaches `RUN_TIMEOUT_MS` ([Status](status.md#requests-during-a-tool-call)).
