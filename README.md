<!-- readme:header:start -->
<p>
  <img alt="status: Archived" src="https://img.shields.io/badge/status-Archived-6e7781">
</p>
<!-- readme:header:end -->

# devbox-mcp

> An MCP server that let an LLM run a project's real test suite and SonarQube scan in throwaway containers, without a raw shell.

<!-- readme:status:start -->
**Archived**. Stopped. The README says what it tried and what survived.
<!-- readme:status:end -->

> [!NOTE]
> **Archived 2026-11-01.** Nothing called it after the migration check on 2026-10-31, and chargehand now runs the
> real tests.

## What it tried

Whether an agent could run a repository's own tests and quality scan through four narrow MCP tools
(`list_projects`, `run_tests`, `sonar_scan`, `sonar_quality_gate`) instead of a shell. Each run happened in a
one-shot container: the repo mounted read-only, a tmpfs for scratch space, and Docker reached only through a
socket proxy limited to containers, POST and images.

## What happened

I wrote it on 2026-09-28 and tagged seven releases, 0.1.0 to 0.7.0, by 2026-09-29. The same day I removed it from my
Claude clients because its auth was broken and I barely used it. It kept running behind my MCP gateway for a month.
On 2026-11-01 I read the gateway log for the last 30 days: 6 requests, all `initialize` or `tools/list` from a
migration smoke test, and no `tools/call`. The agent that really needed test runs, chargehand, got its own.

## What survived

- The socket-proxy pattern: [docs/guide/security-model.md](docs/guide/security-model.md) says why a mounted Docker
  socket is root on the host and which proxy flags narrow it.
- A project allowlist with per-project limits, and a cap on concurrent runs.
- The full working README and the user guide: [docs/history.md](docs/history.md), [docs/guide/](docs/guide/index.md).

## Where it went

Test runs belong to [chargehand](https://github.com/Egoushka/chargehand). The stack was removed from my server in
[Egoushka/homelab#178](https://github.com/Egoushka/homelab/pull/178); this repo stays readable under the MIT licence.

<!-- readme:footer:start -->
---

<sub>Made by [Yehor Hrabovskyi](https://hrabovskyi.online).</sub>
<!-- readme:footer:end -->
