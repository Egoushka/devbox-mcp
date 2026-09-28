import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeSonar } from "../src/sonar-wake.js";

// A fake clock: sleep advances it, so a 180s timeout runs instantly.
function harness({ statuses, dockerCode = 0 }) {
  let t = 0;
  const calls = [];
  const urls = [];
  return {
    calls,
    urls,
    opts: {
      hostUrl: "http://sonar:9000/",
      containers: ["sonarqube-db-1", "sonarqube-sonarqube-1"],
      timeoutMs: 180_000,
      docker: async (args) => {
        calls.push(args.join(" "));
        return { code: dockerCode, output: dockerCode ? "Error: No such container\n" : "" };
      },
      fetchImpl: async (url) => {
        urls.push(url);
        const s = statuses.length > 1 ? statuses.shift() : statuses[0];
        if (s instanceof Error) throw s;
        return { json: async () => ({ status: s }) };
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    },
  };
}

test("already UP: starts db then sonarqube once, then returns", async () => {
  const h = harness({ statuses: ["UP"] });
  await wakeSonar(h.opts);
  assert.deepEqual(h.calls, ["start sonarqube-db-1", "start sonarqube-sonarqube-1"]);
  assert.deepEqual(h.urls, ["http://sonar:9000/api/system/status"]);
});

test("cold start: polls through refused connections and STARTING until UP", async () => {
  const h = harness({ statuses: [new Error("ECONNREFUSED"), "STARTING", "UP"] });
  await wakeSonar(h.opts);
  assert.equal(h.urls.length, 3);
  // Re-issued each poll, db first every time.
  assert.deepEqual(h.calls, [
    "start sonarqube-db-1",
    "start sonarqube-sonarqube-1",
    "start sonarqube-db-1",
    "start sonarqube-sonarqube-1",
    "start sonarqube-db-1",
    "start sonarqube-sonarqube-1",
  ]);
});

test("never UP: rejects with a timeout error naming the last status", async () => {
  const h = harness({ statuses: ["STARTING"] });
  await assert.rejects(wakeSonar(h.opts), /not UP after 180s \(last: status STARTING\)/);
  assert.equal(h.urls.length, 37); // t = 0, 5s, ..., 180s
});

test("docker start fails: rejects at once with docker's output", async () => {
  const h = harness({ statuses: ["UP"], dockerCode: 1 });
  await assert.rejects(
    wakeSonar(h.opts),
    /docker start sonarqube-db-1 failed: Error: No such container/
  );
  assert.equal(h.urls.length, 0);
});
