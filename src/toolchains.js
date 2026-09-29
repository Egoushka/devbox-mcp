// Which test runner a project gets, and in which image.
//
// Detection is by marker file, first match wins, in the order below. A dotnet
// project's SDK image follows its global.json: an SDK image carries only its
// own runtime, so a net10.0 test project cannot run under sdk:8.0. Without a
// usable global.json the image stays sdk:8.0, what every dotnet project got
// before this was read.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DOTNET_SDK = "8.0";

// "10.0.100" -> "10.0". Anything else (no file, bad JSON, no sdk.version, a
// version that is not digits) falls back to the default rather than failing:
// the image tag is built from this string, so it is checked, never trusted.
export function dotnetSdkTag(dir) {
  try {
    const version = JSON.parse(readFileSync(join(dir, "global.json"), "utf8"))?.sdk?.version;
    const m = /^(\d+)\.\d+\.\d+/.exec(version ?? "");
    if (m) return `${m[1]}.0`;
  } catch {
    // no global.json, or not JSON
  }
  return DEFAULT_DOTNET_SDK;
}

// ponytail: image tags, not digests. Pin exact digests in homelab-gitops's
// PINS.md before deploying — this repo only names the toolchain, it doesn't
// vet supply-chain trust for you.
export const RUNNERS = {
  dotnet: {
    marker: (dir) =>
      readdirSync(dir).some((f) => f.endsWith(".sln") || f.endsWith(".slnx") || f.endsWith(".csproj")),
    image: (dir) => `mcr.microsoft.com/dotnet/sdk:${dotnetSdkTag(dir)}`,
    cmd: "cp -r /repo/. /work && cd /work && dotnet test --nologo",
  },
  npm: {
    marker: (dir) => existsSync(join(dir, "package.json")),
    image: () => "node:20-slim",
    cmd: "cp -r /repo/. /work && cd /work && npm ci && npm test",
  },
  pytest: {
    marker: (dir) =>
      existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "requirements.txt")),
    image: () => "python:3.12-slim",
    cmd:
      "cp -r /repo/. /work && cd /work && " +
      "(test -f requirements.txt && pip install -q -r requirements.txt || true) && pytest -q",
  },
};

export function detectType(dir) {
  for (const [name, runner] of Object.entries(RUNNERS)) {
    if (runner.marker(dir)) return name;
  }
  return null;
}
