import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjects, parseProjectsFile } from "../src/projects.js";

const DEFAULTS = { timeoutMs: 600_000, memory: "2g", cpus: 2 };

function root(dirs) {
  const r = mkdtempSync(join(tmpdir(), "devbox-root-"));
  for (const [name, files] of Object.entries(dirs)) {
    mkdirSync(join(r, name));
    for (const f of files) writeFileSync(join(r, name, f), "");
  }
  return r;
}

function file(obj) {
  const p = join(mkdtempSync(join(tmpdir(), "devbox-cfg-")), "projects.json");
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
}

test("without a projects file every directory is a project, with default limits", () => {
  const r = root({ a: ["package.json"], b: [] });
  assert.deepEqual(
    listProjects(r, "", DEFAULTS).map((p) => [p.name, p.type, p.memory]),
    [["a", "npm", "2g"], ["b", null, "2g"]]
  );
});

test("with a projects file only the listed projects are returned", () => {
  const r = root({ chargehand: ["Chargehand.slnx"], stray: ["package.json"] });
  const got = listProjects(r, file({ projects: { chargehand: {} } }), DEFAULTS);
  assert.deepEqual(got.map((p) => p.name), ["chargehand"]);
});

test("a listed project with no checkout is left out", () => {
  const r = root({ a: ["package.json"] });
  assert.deepEqual(listProjects(r, file({ projects: { a: {}, gone: {} } }), DEFAULTS).map((p) => p.name), ["a"]);
});

test("per-project keys override the defaults and detection", () => {
  const r = root({ slow: ["A.sln"] });
  const [p] = listProjects(
    r,
    file({ projects: { slow: { toolchain: "npm", timeoutMs: 1_200_000, memory: "3g", cpus: 1.5 } } }),
    DEFAULTS
  );
  assert.deepEqual(p, { name: "slow", type: "npm", timeoutMs: 1_200_000, memory: "3g", cpus: 1.5 });
});

test("a missing or malformed projects file refuses instead of listing everything", () => {
  const r = root({ a: ["package.json"] });
  assert.throws(() => listProjects(r, join(r, "nope.json"), DEFAULTS), /ENOENT/);
  assert.throws(() => listProjects(r, file("{not json"), DEFAULTS), SyntaxError);
  assert.throws(() => listProjects(r, file({ a: {} }), DEFAULTS), /expected \{"projects"/);
});

test("entries are validated before any value reaches docker run", () => {
  const bad = [
    [{ "../etc": {} }, /plain directory name/],
    [{ a: { memory: "2g --privileged" } }, /memory/],
    [{ a: { cpus: "2" } }, /cpus/],
    [{ a: { timeoutMs: -1 } }, /timeoutMs/],
    [{ a: { toolchain: "cargo" } }, /toolchain/],
    [{ a: { toolchain: "constructor" } }, /toolchain/],
    [{ a: { image: "evil" } }, /unknown key "image"/],
  ];
  for (const [projects, why] of bad) assert.throws(() => parseProjectsFile(JSON.stringify({ projects })), why);
});
