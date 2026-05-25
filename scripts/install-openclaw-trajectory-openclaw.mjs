#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readOpenClawPluginRegistry, sameInstallPath } from "../dist/openclaw-registry.js";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptPath), "..");
const args = parseArgs(process.argv.slice(2));
const home = resolve(args.home ?? defaultHome());
const mode = modeOption(args.mode ?? "auto");
const openclawHome = await resolveOpenClawHome(args, home);
const extensionDir = args["extension-dir"]
  ? resolve(args["extension-dir"])
  : join(openclawHome, ".openclaw", "extensions", "openclaw-trajectory");
const openclawConfigPath = join(openclawHome, ".openclaw", "openclaw.json");
const trajectoryDir = resolve(args["base-dir"] ?? join(home, ".openclaw", "trajectory"));
const statePath = resolve(args["state-path"] ?? join(trajectoryDir, "install-state.json"));
const reportPath = resolve(args["report-path"] ?? join(trajectoryDir, "install-report.json"));
const logPath = resolve(args["log-path"] ?? join(trajectoryDir, "install.log"));
const verifierPath = resolve(args["verifier-path"] ?? join(trajectoryDir, "post-restart-verify.mjs"));
const openclawCommand = args["openclaw-command"] ?? "openclaw";
const s6SvcCommand = args["s6-svc-command"] ?? "s6-svc";
const shouldRegister = args.register !== "false" && args["no-register"] !== "true";
const shouldEnable = args.enable !== "false" && args["no-enable"] !== "true";
const shouldRestart = args.restart === "true";
const shouldDoctor = args.doctor !== "false" && args["no-doctor"] !== "true";
const shouldAllowConversationAccess = args["allow-conversation-access"] === "true";
const forceReinstall = args["force-reinstall"] === "true";
const foregroundVerify = args["foreground-verify"] === "true";
const detachedVerify = shouldRestart && !foregroundVerify && args["detached-verify"] !== "false";
const packageVersion = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")).version ?? null;
const startedAt = new Date().toISOString();
const steps = [];
let installPayload = null;
let restarted = false;
let restartServiceDir = null;
let finalStatus = "running";
let finalMessage = null;
let rootCompletionScript = null;
let rootCompletionCommand = null;
let blockedBy = [];

await mkdir(trajectoryDir, { recursive: true });
await writeState("starting");
await appendLog(`starting OpenClaw sandbox install home=${home}`);

try {
  installPayload = await installToolkit();
  const nativeBlockers = mode === "cli-only" ? [] : await nativePreflight();
  if (mode === "cli-only" || (mode === "auto" && nativeBlockers.length > 0)) {
    blockedBy = nativeBlockers;
    await writeRootCompletionScript();
    finalStatus = "partial";
    finalMessage = nativeBlockers.length > 0 ? "Native hook installation requires OpenClaw runtime write permissions." : "CLI-only mode requested.";
    await writeState("partial_cli_only");
    await writeReport({
      status: "partial",
      mode: "cli-only",
      native_hook_enabled: false,
      blocked_by: blockedBy,
      root_completion_script: rootCompletionScript,
      root_completion_command: rootCompletionCommand
    });
    console.log(stableStringify(await currentReport({
      status: "partial",
      mode: "cli-only",
      native_hook_enabled: false,
      blocked_by: blockedBy,
      root_completion_script: rootCompletionScript,
      root_completion_command: rootCompletionCommand
    })));
    process.exit(0);
  }
  if (mode === "native" && nativeBlockers.length > 0) {
    blockedBy = nativeBlockers;
    throw new Error(`Native install preflight failed: ${nativeBlockers.map((blocker) => `${blocker.code}:${blocker.path ?? ""}`).join(", ")}`);
  }
  await installExtension();
  if (shouldRegister) {
    await registerPluginIdempotently();
  }
  if (shouldEnable) {
    await runTracked("enable_plugin", openclawCommand, ["plugins", "enable", "openclaw-trajectory"]);
  }
  if (shouldAllowConversationAccess) {
    await runTracked("allow_conversation_access", openclawCommand, [
      "config",
      "set",
      "plugins.entries.openclaw-trajectory.hooks.allowConversationAccess",
      "true"
    ]);
  }

  if (shouldRestart) {
    restartServiceDir = await resolveServiceDir();
    if (detachedVerify) {
      await writeDetachedVerifier({
        home,
        trajectoryDir,
        openclawHome,
        reportPath,
        statePath,
        logPath,
        command: installPayload.command,
      timeoutMs: positiveInteger(args["verify-timeout-ms"], 120_000),
      intervalMs: positiveInteger(args["verify-interval-ms"], 2_000),
      allowConversationAccess: shouldAllowConversationAccess,
      startedAt
    });
      spawn(process.execPath, [verifierPath], {
        detached: true,
        stdio: "ignore",
        env: process.env
      }).unref();
      await writeReport({ status: "running", message: "gateway_restart_started_detached_verify_pending" });
    }
    await writeState("restarting_gateway");
    await runTracked("restart_gateway", s6SvcCommand, ["-r", restartServiceDir]);
    restarted = true;
  }

  if (shouldDoctor && !detachedVerify) {
    await runDoctorAndReport();
  } else if (detachedVerify) {
    finalStatus = "running";
    finalMessage = "Gateway restart requested. Detached verifier will update install-report.json after OpenClaw is reachable.";
    await writeState("waiting_for_detached_verify");
    await writeReport({ status: finalStatus, message: finalMessage });
  } else {
    finalStatus = "ok";
    await writeState("complete");
    await writeReport({ status: finalStatus, message: "installed_without_doctor" });
  }

  console.log(stableStringify(await currentReport()));
} catch (error) {
  finalStatus = "error";
  finalMessage = errorMessage(error);
  await appendLog(`ERROR ${finalMessage}`);
  await writeState("error");
  await writeReport({ status: finalStatus, message: finalMessage });
  console.error(finalMessage);
  process.exitCode = 1;
}

async function installToolkit() {
  if (args["skip-toolkit-install"] === "true") {
    const installDir = resolve(args["install-dir"] ?? join(home, ".openclaw", "tools", "openclaw-trajectory-toolkit"));
    return {
      status: "installed",
      tool: "OpenClaw Trajectory Toolkit",
      command: join(home, ".openclaw", "bin", "openclaw-trajectory"),
      install_dir: installDir,
      config: join(home, ".openclaw", "trajectory", "config.json"),
      plugin_manifest: join(home, ".openclaw", "plugins", "openclaw-trajectory", "plugin.json"),
      mode: "cli-only",
      native_hook_enabled: false,
      openclaw_home: openclawHome,
      openclaw_extension_dir: extensionDir,
      openclaw_plugin_manifest: null
    };
  }
  const installArgs = [join(sourceRoot, "scripts", "install-toolkit.mjs"), "--home", home, "--openclaw-home", openclawHome, "--extension-dir", extensionDir];
  if (args["install-dir"]) installArgs.push("--install-dir", resolve(args["install-dir"]));
  if (args["bin-dir"]) installArgs.push("--bin-dir", resolve(args["bin-dir"]));
  if (args["disable-plugin"]) installArgs.push("--disable-plugin", args["disable-plugin"]);
  const result = await runTracked("install_toolkit", process.execPath, installArgs);
  const payload = parseJson(result.stdout, "install-openclaw-trajectory output");
  if (!payload || typeof payload !== "object" || typeof payload.command !== "string" || typeof payload.openclaw_extension_dir !== "string") {
    throw new Error("Base installer did not return command and openclaw_extension_dir");
  }
  return payload;
}

async function installExtension() {
  const result = await runTracked("install_extension", process.execPath, [
    join(sourceRoot, "scripts", "install-extension.mjs"),
    "--source-toolkit",
    installPayload.install_dir,
    "--openclaw-home",
    openclawHome,
    "--extension-dir",
    extensionDir
  ]);
  const payload = parseJson(result.stdout, "install-extension output");
  installPayload = {
    ...installPayload,
    openclaw_home: openclawHome,
    openclaw_extension_dir: payload.openclaw_extension_dir ?? extensionDir,
    openclaw_plugin_manifest: payload.openclaw_plugin_manifest ?? join(extensionDir, "openclaw.plugin.json")
  };
}

async function registerPluginIdempotently() {
  const registry = await readOpenClawPluginRegistry(openclawHome, "openclaw-trajectory");
  const existing = registry.records.find((record) => typeof record.installPath === "string");
  if (!existing?.installPath) {
    await runTracked("register_plugin", openclawCommand, ["plugins", "install", "--link", extensionDir]);
    await refreshInstallRecordMetadata();
    return;
  }
  if (await sameInstallPath(existing.installPath, extensionDir)) {
    await refreshInstallRecordMetadata();
    pushStep("register_plugin", {
      status: "skipped",
      command: `${openclawCommand} plugins install --link ${extensionDir}`,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      reason: "already_registered_same_path",
      registry_source: existing.source,
      install_path: existing.installPath
    });
    await appendLog(`SKIP register_plugin already registered at ${existing.installPath}`);
    await writeState("register_plugin");
    return;
  }
  if (!forceReinstall) {
    throw new Error(
      `plugin_install_path_conflict: openclaw-trajectory is already registered at ${existing.installPath}; requested ${extensionDir}. Re-run with --force-reinstall to remove and reinstall.`
    );
  }
  await runTracked("remove_existing_plugin", openclawCommand, ["plugins", "remove", "openclaw-trajectory"]);
  await runTracked("register_plugin", openclawCommand, ["plugins", "install", "--link", extensionDir]);
  await refreshInstallRecordMetadata();
}

async function refreshInstallRecordMetadata() {
  const installsPath = join(openclawHome, ".openclaw", "plugins", "installs.json");
  const installs = (await readJson(installsPath)) ?? {};
  const installRecords = installs.installRecords && typeof installs.installRecords === "object" && !Array.isArray(installs.installRecords)
    ? installs.installRecords
    : {};
  const existing = installRecords["openclaw-trajectory"] && typeof installRecords["openclaw-trajectory"] === "object" && !Array.isArray(installRecords["openclaw-trajectory"])
    ? installRecords["openclaw-trajectory"]
    : {};
  installRecords["openclaw-trajectory"] = {
    ...existing,
    id: "openclaw-trajectory",
    name: "openclaw-trajectory",
    enabled: existing.enabled ?? true,
    installPath: extensionDir,
    source: "link",
    sourcePath: extensionDir,
    version: installPayload?.version ?? packageVersion,
    updatedAt: new Date().toISOString()
  };
  await writeFileJson(installsPath, {
    ...installs,
    installRecords
  });
  pushStep("refresh_install_metadata", {
    status: "ok",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    registry_path: installsPath,
    install_path: extensionDir,
    version: installPayload?.version ?? packageVersion
  });
}

async function runDoctorAndReport() {
  const doctor = await runTracked("doctor", installPayload.command, ["doctor", "--base-dir", trajectoryDir, "--plugin", "--home", home, "--openclaw-home", openclawHome], {
    allowFailure: true
  });
  const doctorPayload = parseJson(doctor.stdout, "doctor output");
  const status = doctor.code === 0 && doctorPayload?.status === "ok" ? "ok" : doctorPayload?.status === "warning" ? "warning" : "error";
  finalStatus = status;
  finalMessage = status === "ok" ? null : "doctor_reported_issues";
  await writeState(status === "ok" ? "complete" : "doctor_issues");
  await writeReport({
    status,
    message: finalMessage,
    doctor: doctorPayload ?? { status: "error", raw_stdout: doctor.stdout, stderr: doctor.stderr }
  });
  if (status === "error") {
    throw new Error(`doctor failed: ${doctor.stderr || doctor.stdout || "unknown error"}`);
  }
}

async function runTracked(name, command, commandArgs, options = {}) {
  const started = new Date().toISOString();
  const commandText = [command, ...commandArgs].join(" ");
  steps.push({ name, status: "running", command: commandText, started_at: started });
  await writeState(name);
  await appendLog(`RUN ${name}: ${commandText}`);
  try {
    const result = await execFileAsync(command, commandArgs, {
      env: process.env,
      maxBuffer: positiveInteger(args["max-buffer"], 10 * 1024 * 1024)
    });
    updateStep(name, {
      status: "ok",
      ended_at: new Date().toISOString(),
      exit_code: 0,
      stdout_tail: tailText(result.stdout),
      stderr_tail: tailText(result.stderr)
    });
    await appendLog(`OK ${name}`);
    await writeState(name);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const code = typeof error?.code === "number" ? error.code : 1;
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : errorMessage(error);
    updateStep(name, {
      status: options.allowFailure ? "warning" : "error",
      ended_at: new Date().toISOString(),
      exit_code: code,
      stdout_tail: tailText(stdout),
      stderr_tail: tailText(stderr)
    });
    await appendLog(`${options.allowFailure ? "WARN" : "ERROR"} ${name}: ${stderr || stdout}`);
    await writeState(name);
    if (!options.allowFailure) throw error;
    return { code, stdout, stderr };
  }
}

async function resolveServiceDir() {
  if (args["service-dir"]) {
    const serviceDir = resolve(args["service-dir"]);
    await access(serviceDir, constants.R_OK);
    return serviceDir;
  }
  const result = await execFileAsync("find", ["/run", "-path", "*/servicedirs/openclaw", "-type", "d", "-print", "-quit"], {
    maxBuffer: 1024 * 1024
  });
  const serviceDir = result.stdout.trim().split("\n").find(Boolean);
  if (!serviceDir) {
    throw new Error("Could not find OpenClaw s6 service dir. Pass --service-dir /run/.../servicedirs/openclaw.");
  }
  return serviceDir;
}

async function writeDetachedVerifier(config) {
  await writeFile(
    verifierPath,
    [
      "#!/usr/bin/env node",
      "import { execFile } from 'node:child_process';",
      "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
      "import { dirname } from 'node:path';",
      "import { promisify } from 'node:util';",
      "const execFileAsync = promisify(execFile);",
      `const config = ${JSON.stringify(config)};`,
      "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
      "function stable(value) { return JSON.stringify(sort(value)); }",
      "function sort(value) { if (Array.isArray(value)) return value.map(sort); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])); return value; }",
      "function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }",
      "async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }",
      "async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, stable(value) + '\\n', 'utf8'); }",
      "async function appendLog(message) { await mkdir(dirname(config.logPath), { recursive: true }); await writeFile(config.logPath, `[${new Date().toISOString()}] ${message}\\n`, { encoding: 'utf8', flag: 'a' }); }",
      "async function main() {",
      "  const deadline = Date.now() + config.timeoutMs;",
      "  let last = null;",
      "  while (Date.now() <= deadline) {",
      "    try {",
      "      const result = await execFileAsync(config.command, ['doctor', '--base-dir', config.trajectoryDir, '--plugin', '--home', config.home, '--openclaw-home', config.openclawHome], { maxBuffer: 10 * 1024 * 1024 });",
      "      const doctor = parseJson(result.stdout);",
      "      if (doctor && (doctor.status === 'ok' || doctor.status === 'warning')) {",
      "        const base = (await readJson(config.reportPath)) ?? {};",
      "        await writeJson(config.reportPath, { ...base, completed_at: new Date().toISOString(), detached_verify: true, doctor, message: doctor.status === 'ok' ? null : 'doctor_reported_issues', restarted: true, restart_verified: true, status: doctor.status });",
      "        const state = (await readJson(config.statePath)) ?? {};",
      "        await writeJson(config.statePath, { ...state, phase: doctor.status === 'ok' ? 'complete' : 'doctor_issues', updated_at: new Date().toISOString() });",
      "        await appendLog(`detached verifier completed status=${doctor.status}`);",
      "        return;",
      "      }",
      "      last = result.stdout;",
      "    } catch (error) {",
      "      last = error instanceof Error ? error.message : String(error);",
      "    }",
      "    await sleep(config.intervalMs);",
      "  }",
      "  const base = (await readJson(config.reportPath)) ?? {};",
      "  await writeJson(config.reportPath, { ...base, completed_at: new Date().toISOString(), detached_verify: true, message: `detached verifier timed out: ${last ?? 'no output'}`, status: 'error' });",
      "  const state = (await readJson(config.statePath)) ?? {};",
      "  await writeJson(config.statePath, { ...state, phase: 'error', updated_at: new Date().toISOString() });",
      "  await appendLog(`detached verifier timed out: ${last ?? 'no output'}`);",
      "}",
      "main().catch(async (error) => {",
      "  await appendLog(`detached verifier crashed: ${error instanceof Error ? error.message : String(error)}`);",
      "  process.exitCode = 1;",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function currentReport(extra = {}) {
  const openclawConfig = await readJson(openclawConfigPath);
  const registry = await readOpenClawPluginRegistry(openclawHome, "openclaw-trajectory");
  const installPath = registry.records.find((record) => typeof record.installPath === "string")?.installPath ?? null;
  const enabled = openclawConfig?.plugins?.entries?.["openclaw-trajectory"]?.enabled === true;
  const allow = openclawConfig?.plugins?.allow;
  const allowlistAllows = Array.isArray(allow) && allow.length > 0 ? allow.includes("openclaw-trajectory") : true;
  const conversationAccessAllowed = openclawConfig?.plugins?.entries?.["openclaw-trajectory"]?.hooks?.allowConversationAccess === true;
  return {
    schema_version: "openclaw.trajectory-openclaw-install-report/v1",
    status: finalStatus,
    message: finalMessage,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
    home,
    openclaw_home: openclawHome,
    openclaw_config_path: openclawConfigPath,
    mode,
    base_dir: trajectoryDir,
    command: installPayload?.command ?? join(home, ".openclaw", "bin", "openclaw-trajectory"),
    install_dir: installPayload?.install_dir ?? null,
    openclaw_extension_dir: installPayload?.openclaw_extension_dir ?? extensionDir,
    openclaw_plugin_manifest: installPayload?.openclaw_plugin_manifest ?? null,
    plugin_registered: Boolean(installPath),
    plugin_enabled: enabled,
    plugin_allowlist_allows: allowlistAllows,
    plugin_conversation_access_allowed: conversationAccessAllowed,
    plugin_conversation_access_requested: shouldAllowConversationAccess,
    openclaw_install_path: installPath,
    openclaw_registry_source: registry.records[0]?.source ?? null,
    openclaw_policy_diagnostics: {
      conversation_access: {
        current: conversationAccessAllowed,
        intercepted_hooks: ["message_received", "before_model_resolve", "llm_input", "llm_output", "before_tool_call", "after_tool_call", "agent_end", "session_end"],
        sensitive_fields: ["systemPrompt", "historyMessages", "prompt", "assistantTexts", "tool params", "tool results", "message content"],
        sharing_recommendation: "Run redaction or summary-only export before sharing evidence packages."
      },
      behavior_intrusion: {
        observer_only: true,
        fetch_patch: false,
        curl_header_injection: false,
        llm_skip: false
      }
    },
    openclaw_policy_commands: {
      allow_conversation_access: "openclaw config set plugins.entries.openclaw-trajectory.hooks.allowConversationAccess true",
      allowlist_note: "If plugins.allow is non-empty, add openclaw-trajectory to that allowlist."
    },
    restart_requested: shouldRestart,
    restarted,
    restart_service_dir: restartServiceDir,
    detached_verify: detachedVerify,
    verifier_path: detachedVerify ? verifierPath : null,
    state_path: statePath,
    report_path: reportPath,
    log_path: logPath,
    native_hook_enabled: Boolean(installPath && enabled),
    blocked_by: blockedBy,
    root_completion_script: rootCompletionScript,
    root_completion_command: rootCompletionCommand,
    steps,
    ...extra
  };
}

async function writeReport(extra = {}) {
  const report = await currentReport(extra);
  await writeFileJson(reportPath, report);
}

async function writeState(phase) {
  await writeFileJson(statePath, {
    schema_version: "openclaw.trajectory-openclaw-install-state/v1",
    phase,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
    home,
    openclaw_home: openclawHome,
    openclaw_config_path: openclawConfigPath,
    base_dir: trajectoryDir,
    report_path: reportPath,
    log_path: logPath,
    steps
  });
}

async function nativePreflight() {
  const blockers = [];
  const extensionParent = join(openclawHome, ".openclaw", "extensions");
  if (!(await canWritePathParent(extensionDir))) {
    blockers.push({ code: "extension_dir_not_writable", path: extensionParent });
  }
  if (!(await canWriteConfig(openclawConfigPath))) {
    blockers.push({ code: "openclaw_config_not_writable", path: openclawConfigPath });
  }
  if ((shouldRegister || shouldEnable || shouldAllowConversationAccess) && !(await commandExists(openclawCommand))) {
    blockers.push({ code: "openclaw_command_missing", path: openclawCommand });
  }
  return blockers;
}

async function writeRootCompletionScript() {
  rootCompletionScript = join(installPayload.install_dir, "install-extension-as-root.sh");
  const rootBaseDir = join(openclawHome, ".openclaw", "trajectory");
  const argv = [
    "scripts/install-openclaw-trajectory-openclaw.mjs",
    "--mode",
    "native",
    "--skip-toolkit-install",
    "--home",
    home,
    "--openclaw-home",
    openclawHome,
    "--install-dir",
    installPayload.install_dir,
    "--base-dir",
    rootBaseDir,
    "--register",
    "--enable",
    ...(shouldAllowConversationAccess ? ["--allow-conversation-access"] : []),
    ...(shouldRestart ? ["--restart"] : []),
    ...(detachedVerify ? ["--detached-verify"] : ["--foreground-verify"]),
    ...(shouldDoctor ? ["--doctor"] : ["--no-doctor"])
  ];
  rootCompletionCommand = `sudo -H node ${shellQuote(join(installPayload.install_dir, "scripts", "install-openclaw-trajectory-openclaw.mjs"))} ${argv.slice(1).map(shellQuote).join(" ")}`;
  await writeFile(
    rootCompletionScript,
    [
      "#!/usr/bin/env sh",
      "set -eu",
      `node ${shellQuote(join(installPayload.install_dir, "scripts", "install-openclaw-trajectory-openclaw.mjs"))} ${argv.slice(1).map(shellQuote).join(" ")}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

async function resolveOpenClawHome(options, userHome) {
  if (options["openclaw-home"]) return resolve(options["openclaw-home"]);
  if (process.env.OPENCLAW_HOME) return resolve(process.env.OPENCLAW_HOME);
  for (const candidate of ["/mnt/openclaw", "/root", userHome]) {
    if (await exists(join(candidate, ".openclaw", "openclaw.json"))) return resolve(candidate);
  }
  return userHome;
}

async function canWriteConfig(path) {
  if (await exists(path)) return canAccess(path, constants.W_OK);
  return canWritePathParent(path);
}

async function canWritePathParent(path) {
  let current = path;
  while (true) {
    const parent = dirname(current);
    if (await exists(parent)) return canAccess(parent, constants.W_OK);
    if (parent === current) return false;
    current = parent;
  }
}

async function commandExists(command) {
  if (command.includes("/")) return canAccess(command, constants.X_OK);
  try {
    await execFileAsync("sh", ["-c", `command -v ${shellQuote(command)} >/dev/null 2>&1`]);
    return true;
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function canAccess(path, mode) {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function writeFileJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableStringify(value) + "\n", "utf8");
}

async function appendLog(message) {
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `[${new Date().toISOString()}] ${message}\n`, { encoding: "utf8", flag: "a" });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function updateStep(name, patch) {
  const step = [...steps].reverse().find((candidate) => candidate.name === name && candidate.status === "running");
  if (step) Object.assign(step, patch);
}

function pushStep(name, patch) {
  steps.push({ name, ...patch });
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

function defaultHome() {
  if (typeof process.getuid === "function" && process.getuid() === 0) return "/root";
  return homedir();
}

function modeOption(value) {
  if (value === "auto" || value === "native" || value === "cli-only") return value;
  throw new Error(`Invalid --mode ${value}. Expected auto, native, or cli-only.`);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Could not parse ${label} as JSON`);
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function tailText(value) {
  const text = String(value ?? "");
  return text.length <= 4000 ? text : text.slice(-4000);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function stableStringify(value) {
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value) {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortForJson(value[key])]));
  }
  return value;
}
