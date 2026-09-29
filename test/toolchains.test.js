import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNERS, detectType, dotnetSdkTag } from "../src/toolchains.js";

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "devbox-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("a solution in the .slnx format is a dotnet project", () => {
  assert.equal(detectType(project({ "Chargehand.slnx": "<Solution />" })), "dotnet");
});

test(".sln and .csproj still detect as dotnet", () => {
  assert.equal(detectType(project({ "A.sln": "" })), "dotnet");
  assert.equal(detectType(project({ "A.csproj": "<Project />" })), "dotnet");
});

test("no marker file means no toolchain", () => {
  assert.equal(detectType(project({ "README.md": "" })), null);
});

test("the dotnet image follows global.json's SDK major", () => {
  const dir = project({
    "A.slnx": "",
    "global.json": JSON.stringify({ sdk: { version: "10.0.100", rollForward: "latestFeature" } }),
  });
  assert.equal(RUNNERS.dotnet.image(dir), "mcr.microsoft.com/dotnet/sdk:10.0");
});

test("without a usable global.json the dotnet image stays sdk:8.0", () => {
  assert.equal(dotnetSdkTag(project({})), "8.0");
  assert.equal(dotnetSdkTag(project({ "global.json": "not json" })), "8.0");
  assert.equal(dotnetSdkTag(project({ "global.json": JSON.stringify({ sdk: {} }) })), "8.0");
});

test("a global.json version that is not digits never reaches the image tag", () => {
  const dir = project({ "global.json": JSON.stringify({ sdk: { version: "latest; rm -rf /" } }) });
  assert.equal(dotnetSdkTag(dir), "8.0");
});
