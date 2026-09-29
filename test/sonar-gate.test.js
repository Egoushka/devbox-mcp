import { test } from "node:test";
import assert from "node:assert/strict";
import { projectKeyFrom, qualityGate } from "../src/sonar-gate.js";

test("the project key comes from sonar-project.properties in any separator style", () => {
  assert.equal(projectKeyFrom("sonar.projectKey=chargehand\n"), "chargehand");
  assert.equal(projectKeyFrom("# c\nsonar.projectName=X\nsonar.projectKey : my:key \n"), "my:key");
  assert.equal(projectKeyFrom("sonar.projectKey chargehand"), "chargehand");
  assert.equal(projectKeyFrom("#sonar.projectKey=commented\nsonar.sources=src\n"), null);
});

function fakeSonar(routes) {
  const seen = [];
  return {
    seen,
    fetchImpl: async (url, opts) => {
      seen.push({ url, auth: opts.headers.Authorization });
      const path = new URL(url).pathname;
      const [status, body] = routes[path] ?? [404, { errors: [{ msg: "not found" }] }];
      return { ok: status < 400, status, json: async () => body };
    },
  };
}

test("returns the gate, its failing conditions and the analysis it describes", async () => {
  const s = fakeSonar({
    "/api/ce/component": [200, { queue: [], current: { status: "SUCCESS", submittedAt: "t0", executedAt: "t1" } }],
    "/api/qualitygates/project_status": [
      200,
      {
        projectStatus: {
          status: "ERROR",
          conditions: [
            { status: "ERROR", metricKey: "new_coverage", comparator: "LT", errorThreshold: "80", actualValue: "41.2" },
          ],
        },
      },
    ],
  });
  const r = await qualityGate({ hostUrl: "http://sonar:9000/", token: "t", projectKey: "a b", fetchImpl: s.fetchImpl });
  assert.deepEqual(r, {
    projectKey: "a b",
    status: "ERROR",
    pending: false,
    lastTask: { status: "SUCCESS", submittedAt: "t0", executedAt: "t1" },
    conditions: [{ metric: "new_coverage", status: "ERROR", actual: "41.2", comparator: "LT", threshold: "80" }],
  });
  assert.equal(s.seen[1].url, "http://sonar:9000/api/qualitygates/project_status?projectKey=a%20b");
  assert.ok(s.seen.every((c) => c.auth === "Bearer t"));
});

test("a queued analysis is reported as pending, not hidden", async () => {
  const s = fakeSonar({
    "/api/ce/component": [200, { queue: [{ status: "PENDING" }], current: null }],
    "/api/qualitygates/project_status": [200, { projectStatus: { status: "NONE" } }],
  });
  const r = await qualityGate({ hostUrl: "http://sonar:9000", token: "t", projectKey: "k", fetchImpl: s.fetchImpl });
  assert.equal(r.pending, true);
  assert.equal(r.lastTask, null);
  assert.equal(r.status, "NONE");
});

test("SonarQube's own error message comes through", async () => {
  const s = fakeSonar({
    "/api/ce/component": [404, { errors: [{ msg: "Component key 'k' not found" }] }],
  });
  await assert.rejects(
    qualityGate({ hostUrl: "http://sonar:9000", token: "t", projectKey: "k", fetchImpl: s.fetchImpl }),
    /api\/ce\/component: Component key 'k' not found/
  );
});

test("a refused token says what kind of token the gate needs", async () => {
  const s = fakeSonar({ "/api/ce/component": [403, { errors: [{ msg: "Insufficient privileges" }] }] });
  await assert.rejects(
    qualityGate({ hostUrl: "http://sonar:9000", token: "t", projectKey: "k", fetchImpl: s.fetchImpl }),
    /Insufficient privileges \(reading the gate needs .* user token with Browse/
  );
});
