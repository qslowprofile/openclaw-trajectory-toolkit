#!/usr/bin/env node
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const args = process.argv.slice(2);
const result = await execFileAsync(process.execPath, [join(scriptDir, "install-openclaw-trajectory.mjs"), "--skip-extension", "true", ...args], {
  maxBuffer: 10 * 1024 * 1024
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
