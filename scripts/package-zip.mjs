#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptPath), "..");
const packageEntries = [
  "OPENCLAW_INSTALL.md",
  "CHANGELOG.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "dist",
  "schemas",
  "scripts",
  "examples",
  "node_modules"
];

const rootEntries = new Set(packageEntries);
const runtimePackages = new Set([
  "ajv",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
  "ret",
  "safe-regex2"
]);

const args = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
const out = resolve(args.out ?? join(sourceRoot, "package", `openclaw-trajectory-toolkit-${pkg.version}.zip`));
const stageParent = await mkdtemp(join(tmpdir(), "openclaw-trajectory-package-"));
const stageRoot = join(stageParent, "openclaw-trajectory-toolkit");

try {
  await assertPackageRoot(sourceRoot, pkg);
  await cp(sourceRoot, stageRoot, {
    recursive: true,
    filter: (path) => shouldPackage(path, sourceRoot)
  });
  await mkdir(dirname(out), { recursive: true });
  await rm(out, { force: true });
  await execFileAsync("zip", ["-rq", out, ...packageEntries], {
    cwd: stageRoot,
    maxBuffer: 10 * 1024 * 1024
  });
  console.log(JSON.stringify({ status: "ok", out, version: pkg.version }));
} finally {
  await rm(stageParent, { recursive: true, force: true });
}

function shouldPackage(path, root) {
  const relative = path.slice(root.length).replaceAll("\\", "/");
  if (relative === "") return true;
  const first = relative.split("/").filter(Boolean)[0];
  if (!rootEntries.has(first)) return false;
  if (first !== "node_modules") return true;
  if (relative === "/node_modules") return true;
  const nodeModule = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(relative)?.[1];
  return Boolean(nodeModule && runtimePackages.has(nodeModule));
}

async function assertPackageRoot(root, packageJson) {
  if (packageJson.name !== "openclaw-trajectory-toolkit") {
    throw new Error(`Unexpected package root: ${root}`);
  }
  for (const requiredPath of [
    "dist/cli.js",
    "dist/openclaw-plugin.js",
    "scripts/install-openclaw-trajectory-openclaw.mjs",
    "scripts/install-openclaw-trajectory.mjs",
    "scripts/smoke-test.mjs",
    "schemas/manifest.json",
    "schemas/trajectory.schema.json"
  ]) {
    await access(join(root, requiredPath), constants.R_OK);
  }
  const manifest = JSON.parse(await readFile(join(root, "schemas", "manifest.json"), "utf8"));
  if (manifest.toolkit_version !== packageJson.version) {
    throw new Error(`schemas/manifest.json toolkit_version ${manifest.toolkit_version} does not match package.json version ${packageJson.version}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const eqIndex = token.indexOf("=");
    if (eqIndex > 2) {
      parsed[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
