import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { wakeSonar } from "./sonar-wake.js";
import { projectKeyFrom, qualityGate } from "./sonar-gate.js";
import { RUNNERS } from "./toolchains.js";
import { listProjects as listProjectsIn } from "./projects.js";

const PROJECTS_ROOT = resolve(process.env.PROJECTS_ROOT || "/srv/chargehand/repos");
// Optional allowlist with per-project limits (src/projects.js). Unset: every
// directory under PROJECTS_ROOT, as before.
const PROJECTS_FILE = process.env.PROJECTS_FILE || "";
const SONAR_HOST_URL = process.env.SONAR_HOST_URL || "";
const SONAR_TOKEN = process.env.SONAR_TOKEN || "";
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 10 * 60 * 1000);
// Containers `sonar_scan` starts, in order, before scanning; empty disables
// the wake. `??`, not `||`: SONAR_CONTAINERS="" must mean "none".
const SONAR_CONTAINERS = (process.env.SONAR_CONTAINERS ?? "sonarqube-db-1,sonarqube-sonarqube-1")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// A cold start measured 33s to UP; 180s leaves room for a busy host.
const SONAR_WAKE_TIMEOUT_MS = Number(process.env.SONAR_WAKE_TIMEOUT_MS || 180 * 1000);
const MAX_OUTPUT_CHARS = 20_000;

const DEFAULT_LIMITS = { timeoutMs: RUN_TIMEOUT_MS, memory: "2g", cpus: 2 };

function listProjects() {
  return listProjectsIn(PROJECTS_ROOT, PROJECTS_FILE, DEFAULT_LIMITS);
}

// Resolves `project` against the allowlist `list_projects` itself returns —
// the only thing that stops a path-traversal or injected `../../` argument
// from escaping PROJECTS_ROOT.
function resolveProject(project) {
  const known = listProjects().find((p) => p.name === project);
  if (!known) throw new Error(`unknown project "${project}" — call list_projects first`);
  const dir = join(PROJECTS_ROOT, project);
  if (relative(PROJECTS_ROOT, dir).startsWith("..")) throw new Error("invalid project path");
  return { ...known, dir };
}

function runContainer(args, { timeoutMs = RUN_TIMEOUT_MS } = {}) {
  return new Promise((res) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const kill = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      clearTimeout(kill);
      res({ code, output: out.slice(-MAX_OUTPUT_CHARS) });
    });
  });
}

const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });

// What both sonar tools need before talking to SonarQube: config, a known
// project with a sonar-project.properties, and a server that is awake.
// Returns { dir } or { error } (an MCP error result).
async function sonarReady(project) {
  if (!SONAR_HOST_URL || !SONAR_TOKEN) return { error: toolError("SONAR_HOST_URL / SONAR_TOKEN not configured") };
  const { dir } = resolveProject(project);
  if (!existsSync(join(dir, "sonar-project.properties"))) {
    return { error: toolError(`no sonar-project.properties in "${project}"`) };
  }
  if (SONAR_CONTAINERS.length) {
    try {
      await wakeSonar({
        hostUrl: SONAR_HOST_URL,
        containers: SONAR_CONTAINERS,
        timeoutMs: SONAR_WAKE_TIMEOUT_MS,
        docker: (args) => runContainer(args, { timeoutMs: 60 * 1000 }),
      });
    } catch (err) {
      return { error: toolError(err.message) };
    }
  }
  return { dir };
}

const server = new McpServer({ name: "devbox-mcp", version: "0.5.0" });

server.registerTool(
  "list_projects",
  {
    description:
      `List projects under ${PROJECTS_ROOT}` +
      (PROJECTS_FILE ? " named in the projects file" : "") +
      ", with their toolchain (dotnet/npm/pytest/unknown) and run_tests limits.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: JSON.stringify(listProjects(), null, 2) }],
  })
);

server.registerTool(
  "run_tests",
  {
    description:
      "Run a project's real test suite in a throwaway, read-only-mounted container. " +
      "Project must be one returned by list_projects.",
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    const { dir, type, timeoutMs, memory, cpus } = resolveProject(project);
    if (!type || !RUNNERS[type]) {
      return {
        content: [{ type: "text", text: `no supported toolchain detected for "${project}"` }],
        isError: true,
      };
    }
    const runner = RUNNERS[type];
    const name = `devbox-run-${randomUUID()}`;
    const { code, output } = await runContainer([
      "run",
      "--rm",
      "--name",
      name,
      `--memory=${memory}`,
      `--cpus=${cpus}`,
      // ponytail: package restore (npm ci / dotnet restore / pip install)
      // needs registry access, so this can't be --network=none. That's the
      // real exposure: test/restore code in the project gets outbound network
      // from the VPS. Narrow with an egress-only proxy if that's ever a
      // problem in practice.
      "-v",
      `${dir}:/repo:ro`,
      "--tmpfs",
      "/work:size=4g,exec",
      "-w",
      "/work",
      runner.image(dir),
      "sh",
      "-c",
      runner.cmd,
    ], { timeoutMs });
    return { content: [{ type: "text", text: output }], isError: code !== 0 };
  }
);

server.registerTool(
  "sonar_scan",
  {
    description:
      "Run a SonarQube scan for a project against the configured SonarQube server, " +
      "starting SonarQube first if it is asleep (can take ~30s). " +
      "Requires a sonar-project.properties file in the project.",
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    const { dir, error } = await sonarReady(project);
    if (error) return error;
    const name = `devbox-sonar-${randomUUID()}`;
    const { code, output } = await runContainer([
      "run",
      "--rm",
      "--name",
      name,
      "--memory=2g",
      "--cpus=2",
      "-v",
      `${dir}:/usr/src:ro`,
      "-e",
      `SONAR_HOST_URL=${SONAR_HOST_URL}`,
      "-e",
      `SONAR_TOKEN=${SONAR_TOKEN}`,
      "sonarsource/sonar-scanner-cli:latest",
    ]);
    return { content: [{ type: "text", text: output }], isError: code !== 0 };
  }
);

server.registerTool(
  "sonar_quality_gate",
  {
    description:
      "Quality-gate status (OK/ERROR/NONE) and failing conditions of a project's latest " +
      "SonarQube analysis. Analysis finishes after sonar_scan returns: if `pending` is true, " +
      "the result is still the previous analysis; call again later. Starts SonarQube if asleep.",
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    const { dir, error } = await sonarReady(project);
    if (error) return error;
    const key = projectKeyFrom(readFileSync(join(dir, "sonar-project.properties"), "utf8"));
    if (!key) return toolError(`no sonar.projectKey in "${project}"'s sonar-project.properties`);
    try {
      const gate = await qualityGate({ hostUrl: SONAR_HOST_URL, token: SONAR_TOKEN, projectKey: key });
      return { content: [{ type: "text", text: JSON.stringify(gate, null, 2) }] };
    } catch (err) {
      return toolError(err.message);
    }
  }
);

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT || 8000);
app.listen(port, () => console.log(`devbox-mcp listening on :${port}, projects root ${PROJECTS_ROOT}`));
