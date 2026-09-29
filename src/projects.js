// Which projects the tools may touch, and with what limits.
//
// Without a projects file every directory under the root is a project, as
// before. With one, only the projects it names are: a checkout that appears
// under the root is not runnable until someone adds a line for it. The file is
// read on every call, so an edit applies without a restart, and a missing or
// malformed file refuses every call instead of falling back to "everything".
//
// Format: {"projects": {"<dir name>": {toolchain?, timeoutMs?, memory?, cpus?}}}
// Each key overrides detection or the default limit for that project's
// run_tests container.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNERS, detectType } from "./toolchains.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MEMORY = /^[1-9][0-9]*[kmg]$/;
const KEYS = ["toolchain", "timeoutMs", "memory", "cpus"];

export function parseProjectsFile(text) {
  const doc = JSON.parse(text);
  if (!doc || typeof doc.projects !== "object" || Array.isArray(doc.projects)) {
    throw new Error('projects file: expected {"projects": {...}}');
  }
  const out = {};
  for (const [name, entry] of Object.entries(doc.projects)) {
    const o = entry ?? {};
    const bad = (why) => new Error(`projects file: "${name}": ${why}`);
    if (!NAME.test(name)) throw bad("not a plain directory name");
    if (typeof o !== "object" || Array.isArray(o)) throw bad("expected an object");
    for (const k of Object.keys(o)) if (!KEYS.includes(k)) throw bad(`unknown key "${k}"`);
    if (o.toolchain !== undefined && !Object.hasOwn(RUNNERS, o.toolchain)) {
      throw bad(`toolchain must be one of ${Object.keys(RUNNERS).join(", ")}`);
    }
    if (o.timeoutMs !== undefined && !(Number.isInteger(o.timeoutMs) && o.timeoutMs > 0)) {
      throw bad("timeoutMs must be a positive integer");
    }
    if (o.memory !== undefined && !MEMORY.test(o.memory)) throw bad('memory must look like "2g" or "1536m"');
    if (o.cpus !== undefined && !(typeof o.cpus === "number" && o.cpus > 0 && o.cpus <= 16)) {
      throw bad("cpus must be a number between 0 and 16");
    }
    out[name] = o;
  }
  return out;
}

// defaults: {timeoutMs, memory, cpus}. A listed project with no directory
// under root is left out: list_projects shows what can actually run.
export function listProjects(root, projectsFile, defaults) {
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const listed = projectsFile
    ? parseProjectsFile(readFileSync(projectsFile, "utf8"))
    : Object.fromEntries(dirs.map((d) => [d, {}]));
  return Object.entries(listed)
    .filter(([name]) => dirs.includes(name))
    .map(([name, o]) => ({
      name,
      type: o.toolchain ?? detectType(join(root, name)),
      timeoutMs: o.timeoutMs ?? defaults.timeoutMs,
      memory: o.memory ?? defaults.memory,
      cpus: o.cpus ?? defaults.cpus,
    }));
}
