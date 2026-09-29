import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

// Stands in for the docker CLI: logs its arguments, and `run` holds until the
// gate file exists, so a test can send requests while a tool call is running.
// sleep gets no stdout/stderr, so a SIGKILL to this script closes the pipes.
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = run ]; then
  while [ ! -e "$FAKE_DOCKER_GATE" ]; do sleep 0.05 </dev/null >/dev/null 2>&1; done
  echo "fake tests passed"
fi
`;

// A project root with one npm project, and the fake docker first on PATH. The
// gate opens after the test whatever happens, so no fake run outlives it.
function fixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), "devbox-server-"));
  mkdirSync(join(tmp, "bin"));
  writeFileSync(join(tmp, "bin", "docker"), FAKE_DOCKER, { mode: 0o755 });
  mkdirSync(join(tmp, "root", "app"), { recursive: true });
  writeFileSync(join(tmp, "root", "app", "package.json"), "{}");
  const log = join(tmp, "docker.log");
  const openGate = () => writeFileSync(join(tmp, "gate"), "");
  t.after(openGate);
  return {
    // Empty counts as unset, so a PROJECTS_FILE, RUN_TIMEOUT_MS or
    // MAX_CONCURRENT_RUNS exported in the shell that runs the tests stays out of
    // the server.
    env: {
      PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
      PROJECTS_ROOT: join(tmp, "root"),
      PROJECTS_FILE: "",
      RUN_TIMEOUT_MS: "",
      MAX_CONCURRENT_RUNS: "",
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_GATE: join(tmp, "gate"),
    },
    dockerLog: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    openGate,
  };
}

// Starts src/index.js on a free port and connects an MCP SDK client to it.
// `call(promise)` fails as soon as the server exits, with its output: a crash
// would otherwise leave the client waiting out its own request timeout.
async function serve(t, env, transportOptions) {
  const child = spawn(process.execPath, [INDEX], {
    env: { ...process.env, ...env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((_, reject) =>
    child.on("exit", (code) => reject(new Error(`server exited with ${code}:\n${output}`)))
  );
  exited.catch(() => {});
  const call = (promise) => Promise.race([promise, exited]);
  const alive = () => child.exitCode === null && child.signalCode === null;
  // Also stops when the server exits, so no poll outlives a failed start.
  await call(until(() => !alive() || /listening on :\d+/.test(output), "the server to listen"));
  const url = new URL(`http://127.0.0.1:${/listening on :(\d+)/.exec(output)[1]}/mcp`);

  const client = new Client({ name: "devbox-test", version: "0.0.0" });
  await call(client.connect(new StreamableHTTPClientTransport(url, transportOptions)));
  t.after(async () => {
    await client.close();
    if (alive()) {
      child.kill();
      await once(child, "exit");
    }
  });
  return { client, call, alive, output: () => output };
}

async function until(check, what) {
  for (const deadline = Date.now() + 5000; !check(); ) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const runTests = { name: "run_tests", arguments: { project: "app" } };

test("a request that arrives during run_tests gets its answer, and the run still returns", async (t) => {
  const f = fixture(t);
  const s = await serve(t, f.env);
  const run = s.call(s.client.callTool(runTests));
  await until(() => f.dockerLog().startsWith("run "), "docker run");

  const { tools } = await s.call(s.client.listTools());
  assert.deepEqual(tools.map((tool) => tool.name), ["list_projects", "run_tests", "sonar_scan", "sonar_quality_gate"]);

  f.openGate();
  const result = await run;
  assert.equal(result.isError, false);
  assert.equal(result.content[0].text, "fake tests passed\n");
  assert.ok(s.alive(), s.output());
});

test("a client that times out a call and cancels it leaves the server up", async (t) => {
  const f = fixture(t);
  const cancels = [];
  const s = await serve(t, f.env, {
    fetch: (url, init) => {
      const res = fetch(url, init);
      if (String(init?.body).includes('"notifications/cancelled"')) cancels.push(res.then((r) => r.status));
      return res;
    },
  });
  const errors = [];
  s.client.onerror = (err) => errors.push(err.message);
  await assert.rejects(s.call(s.client.callTool(runTests, undefined, { timeout: 200 })), /Request timed out/);
  await until(() => cancels.length === 1, "the cancellation");
  assert.equal(await s.call(cancels[0]), 202);

  const listed = await s.call(s.client.callTool({ name: "list_projects", arguments: {} }));
  assert.equal(JSON.parse(listed.content[0].text)[0].name, "app");

  // The cancellation stops nothing: a stateless server cannot match it to the
  // call. The run goes on, and its answer arrives after the client gave up.
  f.openGate();
  const late = (m) => m.includes("unknown message ID") && m.includes("fake tests passed");
  await until(() => errors.some(late), "the late answer");
  assert.ok(s.alive(), s.output());
});

test("without a docker CLI on PATH, run_tests is an error result, not a crash", async (t) => {
  const f = fixture(t);
  const s = await serve(t, { ...f.env, PATH: mkdtempSync(join(tmpdir(), "devbox-nobin-")) });
  const result = await s.call(s.client.callTool(runTests));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^could not run docker: spawn docker ENOENT/);
  // The failed run gave its slot back: the next call fails the same way, not as busy.
  const again = await s.call(s.client.callTool(runTests));
  assert.match(again.content[0].text, /^could not run docker/);
  assert.ok(s.alive(), s.output());
});

test("a run that hits its timeout is killed by container name and says so", async (t) => {
  const f = fixture(t);
  const s = await serve(t, { ...f.env, RUN_TIMEOUT_MS: "300" });
  const result = await s.call(s.client.callTool(runTests));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /devbox-mcp: timed out after 0\.3s$/);
  const [, name] = /--name (devbox-run-[0-9a-f-]+) /.exec(f.dockerLog());
  await until(() => f.dockerLog().includes(`kill ${name}\n`), `docker kill ${name}`);
});

const runs = (f) => (f.dockerLog().match(/^run /gm) ?? []).length;
const sonarScan = { name: "sonar_scan", arguments: { project: "app" } };
// A refusal comes back at once; without the cap the call would wait on the gate.
const refusedCall = (s, tool) => s.call(s.client.callTool(tool, undefined, { timeout: 5000 }));

test("a run past MAX_CONCURRENT_RUNS (default 1) is refused, and a freed slot takes the next", async (t) => {
  const f = fixture(t);
  const s = await serve(t, f.env);
  const first = s.call(s.client.callTool(runTests));
  await until(() => runs(f) === 1, "docker run");

  const second = await refusedCall(s, runTests);
  assert.equal(second.isError, true);
  assert.match(
    second.content[0].text,
    /^busy: run_tests app \(\d+s\) already running, the limit of 1 \(MAX_CONCURRENT_RUNS\); call again when one finishes$/
  );
  assert.equal(runs(f), 1);

  f.openGate();
  assert.equal((await first).isError, false);
  assert.equal((await s.call(s.client.callTool(runTests))).isError, false);
  assert.equal(runs(f), 2);
});

test("MAX_CONCURRENT_RUNS=2 runs two at once and refuses a third", async (t) => {
  const f = fixture(t);
  const s = await serve(t, { ...f.env, MAX_CONCURRENT_RUNS: "2" });
  const both = [s.call(s.client.callTool(runTests)), s.call(s.client.callTool(runTests))];
  await until(() => runs(f) === 2, "two docker runs");

  const third = await refusedCall(s, runTests);
  assert.match(third.content[0].text, /^busy: run_tests app \(\d+s\), run_tests app \(\d+s\) already running, the limit of 2 /);
  f.openGate();
  for (const result of await Promise.all(both)) assert.equal(result.isError, false);
});

test("a sonar_scan holds a run slot too", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.env.PROJECTS_ROOT, "app", "sonar-project.properties"), "sonar.projectKey=app\n");
  const s = await serve(t, { ...f.env, SONAR_HOST_URL: "http://127.0.0.1:9", SONAR_TOKEN: "t", SONAR_CONTAINERS: "" });
  const scan = s.call(s.client.callTool(sonarScan));
  await until(() => runs(f) === 1, "docker run");

  const tests = await refusedCall(s, runTests);
  assert.match(tests.content[0].text, /^busy: sonar_scan app \(\d+s\) already running/);
  f.openGate();
  assert.equal((await scan).isError, false);
});

test("a full cap refuses sonar_scan before it wakes SonarQube", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.env.PROJECTS_ROOT, "app", "sonar-project.properties"), "sonar.projectKey=app\n");
  const s = await serve(t, {
    ...f.env,
    SONAR_HOST_URL: "http://127.0.0.1:9",
    SONAR_TOKEN: "t",
    SONAR_CONTAINERS: "sonar-db",
    SONAR_WAKE_TIMEOUT_MS: "1",
  });
  const run = s.call(s.client.callTool(runTests));
  await until(() => runs(f) === 1, "docker run");

  const scan = await refusedCall(s, sonarScan);
  assert.match(scan.content[0].text, /^busy: run_tests app \(\d+s\) already running/);
  assert.doesNotMatch(f.dockerLog(), /^start /m);
  f.openGate();
  assert.equal((await run).isError, false);
});

test("a MAX_CONCURRENT_RUNS that is not a positive integer stops the server at startup", async (t) => {
  const f = fixture(t);
  for (const bad of ["two", "0", "1.5"]) {
    await assert.rejects(
      serve(t, { ...f.env, MAX_CONCURRENT_RUNS: bad }),
      new RegExp(`server exited with 1:[\\s\\S]*MAX_CONCURRENT_RUNS must be a positive integer, got "${bad}"`)
    );
  }
});
