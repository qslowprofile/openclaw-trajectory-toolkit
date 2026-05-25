#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const baseDir = await mkdtemp(join(tmpdir(), "openclaw-trajectory-smoke-"));

try {
  const quicktest = await runCli(["quicktest", "--base-dir", baseDir, "--json"]);
  if (quicktest.status !== "ok" || quicktest.validate?.ok !== true) {
    throw new Error(`quicktest failed: ${JSON.stringify(quicktest)}`);
  }
  const validate = await runCli(["validate", "--run-dir", quicktest.run_dir]);
  if (validate.ok !== true) {
    throw new Error(`validate failed: ${JSON.stringify(validate)}`);
  }
  const report = JSON.parse(await readFile(join(quicktest.run_dir, "normalization_report.json"), "utf8"));
  if (report.coverage?.schema_version !== "openclaw.normalization-coverage/v1") {
    throw new Error("normalization coverage is missing from smoke run");
  }
  console.log(
    JSON.stringify({
      status: "ok",
      run_dir: quicktest.run_dir,
      step_count: quicktest.quality?.step_count ?? null
    })
  );
} finally {
  await rm(baseDir, { recursive: true, force: true });
}

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}
