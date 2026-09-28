# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting on this repository (Security tab → "Report a
vulnerability"). Don't open a public issue. Expect an acknowledgement within 7 days.

## Scope notes

devbox-mcp launches containers through the Docker API, so it is only as narrow as the
docker-socket-proxy in front of it (README, "Why this needs a Docker API proxy"). Report any
path where a tool argument escapes `PROJECTS_ROOT`, a run gets write access to a mounted
repository, or a call reaches a Docker API endpoint beyond what `run_tests` and `sonar_scan`
need.

## Supported versions

Only the latest image tag and the latest commit on `main`.
