#!/usr/bin/env node
import { constants } from "node:fs";
import { access, chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(scriptPath), "..");
const args = parseArgs(process.argv.slice(2));
const home = args.home ? resolve(args.home) : homedir();
const openclawHome = args["openclaw-home"] ? resolve(args["openclaw-home"]) : home;
const installDir = args["install-dir"]
  ? resolve(args["install-dir"])
  : join(home, ".openclaw", "tools", "openclaw-trajectory-toolkit");
const binDir = args["bin-dir"] ? resolve(args["bin-dir"]) : join(home, ".openclaw", "bin");
const binPath = join(binDir, "openclaw-trajectory");
const cmdPath = join(binDir, "openclaw-trajectory.cmd");
const configPath = join(home, ".openclaw", "trajectory", "config.json");
const pluginDir = join(home, ".openclaw", "plugins", "openclaw-trajectory");
const pluginManifestPath = join(pluginDir, "plugin.json");
const extensionDir = args["extension-dir"] ? resolve(args["extension-dir"]) : join(openclawHome, ".openclaw", "extensions", "openclaw-trajectory");
const extensionManifestPath = join(extensionDir, "openclaw.plugin.json");
const pluginEnabled = args["disable-plugin"] !== "true";
const skipExtension = args["skip-extension"] === "true";
const packageVersion = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")).version ?? null;

await assertPackageRoot(sourceRoot);
await rm(installDir, { recursive: true, force: true });
await mkdir(dirname(installDir), { recursive: true });
await copyPackage(sourceRoot, installDir);
await mkdir(binDir, { recursive: true });
await writeFile(
  binPath,
  ["#!/usr/bin/env sh", `node "${join(installDir, "dist", "cli.js")}" "$@"`, ""].join("\n"),
  "utf8"
);
await chmod(binPath, 0o755);
if (process.platform === "win32") {
  await writeFile(cmdPath, [`@echo off`, `node "${join(installDir, "dist", "cli.js")}" %*`, ""].join("\r\n"), "utf8");
}
await mkdir(dirname(configPath), { recursive: true });
await writeFile(
  configPath,
  stableStringify(
    {
      schema_version: "openclaw.trajectory-install/v1",
      installed_at: new Date().toISOString(),
      install_dir: installDir,
      bin_path: binPath,
      default_base_dir: join(home, ".openclaw", "trajectory")
    }
  ) + "\n",
  "utf8"
);
await mkdir(pluginDir, { recursive: true });
await writeFile(
  pluginManifestPath,
  stableStringify({
    schema_version: "openclaw.trajectory-plugin/v1",
    name: "openclaw-trajectory",
    version: packageVersion,
    installed_at: new Date().toISOString(),
    enabled: pluginEnabled,
    auto_enable: pluginEnabled,
    mode: "native",
    entry: join(installDir, "dist", "openclaw-plugin.js"),
    register_entry: join(installDir, "dist", "register.js"),
    openclaw_home: openclawHome,
    openclaw_extension_dir: extensionDir,
    openclaw_plugin_manifest: extensionManifestPath,
    default_base_dir: join(home, ".openclaw", "trajectory"),
    supported_hooks: ["run", "session", "model", "tool", "message", "skill", "shell", "file", "mcp", "state", "subagent", "compaction", "diagnostic"]
  }) + "\n",
  "utf8"
);
if (!skipExtension) {
  await writeOpenClawExtension();
}

console.log(
  stableStringify(
    {
      status: "installed",
      tool: "OpenClaw Trajectory Toolkit",
      command: binPath,
      command_cmd: process.platform === "win32" ? cmdPath : null,
      install_dir: installDir,
      config: configPath,
      plugin_manifest: pluginManifestPath,
      mode: skipExtension ? "cli-only" : "native",
      native_hook_enabled: !skipExtension,
      openclaw_home: openclawHome,
      openclaw_extension_dir: extensionDir,
      openclaw_plugin_manifest: skipExtension ? null : extensionManifestPath,
      version: packageVersion,
      openclaw_install_command: `openclaw plugins install --link "${extensionDir}"`,
      openclaw_allow_conversation_access_command: `openclaw config set plugins.entries.openclaw-trajectory.hooks.allowConversationAccess true`,
      openclaw_allowlist_note: "If plugins.allow is non-empty, add openclaw-trajectory to that allowlist before restarting the gateway.",
      openclaw_sandbox_install_command: `node scripts/install-openclaw-trajectory-openclaw.mjs --mode auto --home "$HOME" --register --enable --allow-conversation-access --restart --detached-verify --doctor`,
      next: `openclaw plugins install --link "${extensionDir}" && ${binPath} doctor --base-dir ${join(home, ".openclaw", "trajectory")} --plugin --home ${home}`
    }
  )
);

async function writeOpenClawExtension() {
  await rm(extensionDir, { recursive: true, force: true });
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "package.json"),
    stableStringify({
      name: "openclaw-trajectory",
      version: packageVersion,
      private: true,
      type: "module",
      main: "./index.mjs",
      openclaw: {
        extensions: ["./index.mjs"]
      },
      peerDependencies: {
        openclaw: ">=2026.2.0"
      }
    }) + "\n",
    "utf8"
  );
  await writeFile(
    join(extensionDir, "index.mjs"),
    [
      `import register from ${JSON.stringify(pathToFileURL(join(installDir, "dist", "openclaw-plugin.js")).href)};`,
      "export default register;",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    extensionManifestPath,
    stableStringify({
      id: "openclaw-trajectory",
      name: "OpenClaw Trajectory",
      version: packageVersion,
      description: "Native OpenClaw trajectory capture plugin. Records model, tool, message, subagent, compaction, and lifecycle hooks without relying on model-initiated tool calls.",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          baseDir: {
            type: "string",
            default: join(home, ".openclaw", "trajectory"),
            description: "Directory where trajectory runs are stored."
          },
          finalizeDelayMs: {
            type: "integer",
            minimum: 0,
            default: 3000,
            description: "Delay after agent_end before finalizing, allowing late llm_output/message hooks to arrive."
          },
          normalizeOnFinalize: {
            type: "boolean",
            default: true,
            description: "Normalize each run after delayed finalize."
          },
          captureMessageEvents: {
            type: "boolean",
            default: true,
            description: "Record message_sending/message_sent lifecycle hooks and correlate them to message tool calls when possible."
          },
          captureDiagnostics: {
            type: "boolean",
            default: true,
            description: "Capture OpenClaw diagnostic events when plugin-sdk exposes onDiagnosticEvent."
          },
          startupScavenge: {
            type: "boolean",
            default: true,
            description: "Scan stale running trajectory runs when the plugin starts and recover or mark them."
          },
          startupScavengeStaleAfterMs: {
            type: "integer",
            minimum: 0,
            default: 3600000,
            description: "Age threshold for startup stale-run recovery."
          },
          allowConversationAccessRequired: {
            type: "boolean",
            default: true,
            description: "Documentation flag: llm_input, llm_output, and agent_end require plugins.entries.openclaw-trajectory.hooks.allowConversationAccess=true in OpenClaw."
          }
        }
      }
    }) + "\n",
    "utf8"
  );
  await writeFile(
    join(extensionDir, "README.md"),
    [
      "# OpenClaw Trajectory",
      "",
      "Native OpenClaw plugin entry for openclaw-trajectory-toolkit.",
      "",
      "Install with:",
      "",
      "```bash",
      `openclaw plugins install --link "${extensionDir}"`,
      "openclaw plugins enable openclaw-trajectory",
      "```",
      ""
    ].join("\n"),
    "utf8"
  );
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

async function assertPackageRoot(root) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== "openclaw-trajectory-toolkit") {
    throw new Error(`Unexpected package root: ${root}`);
  }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json is missing version");
  }
  const manifest = JSON.parse(await readFile(join(root, "schemas", "manifest.json"), "utf8"));
  if (manifest.toolkit_version !== pkg.version) {
    throw new Error(`schemas/manifest.json toolkit_version ${manifest.toolkit_version} does not match package.json version ${pkg.version}`);
  }
  await access(join(root, "dist", "cli.js"), constants.R_OK);
  await access(join(root, "dist", "openclaw-plugin.js"), constants.R_OK);
  await access(join(root, "scripts", "install-openclaw-trajectory-openclaw.mjs"), constants.R_OK);
  await access(join(root, "scripts", "install-extension.mjs"), constants.R_OK);
  await access(join(root, "schemas", "event.schema.json"), constants.R_OK);
  await access(join(root, "schemas", "manifest.json"), constants.R_OK);
  await access(join(root, "schemas", "mcp.schema.json"), constants.R_OK);
  await access(join(root, "schemas", "run-pid.schema.json"), constants.R_OK);
  await access(join(root, "schemas", "trajectory-merge.schema.json"), constants.R_OK);
  await access(join(root, "schemas", "artifact-index.schema.json"), constants.R_OK);
  await access(join(root, "schemas", "trajectory-plugin.schema.json"), constants.R_OK);
}

async function copyPackage(source, target) {
  const runtimePackages = new Set([
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
    "ret",
    "safe-regex2"
  ]);
  await cp(source, target, {
    recursive: true,
    filter: (path) => {
      const relative = path.slice(source.length).replaceAll("\\", "/");
      if (relative === "") return true;
      if (relative === "/node_modules") return true;
      const nodeModule = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(relative)?.[1];
      if (nodeModule && runtimePackages.has(nodeModule)) return true;
      if (relative.startsWith("/node_modules/")) return false;
      return ![
        "/package",
        "/.git",
        "/.claude",
        "/.DS_Store",
        "/test",
        "/docs",
        "/src",
        "/tsconfig.json",
        "/package-lock.json"
      ].some((blocked) => relative === blocked || relative.startsWith(`${blocked}/`));
    }
  });
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
