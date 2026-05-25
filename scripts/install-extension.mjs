#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = parseArgs(process.argv.slice(2));
const sourceToolkit = resolve(requiredOption(args, "source-toolkit"));
const openclawHome = resolve(requiredOption(args, "openclaw-home"));
const extensionDir = args["extension-dir"] ? resolve(args["extension-dir"]) : join(openclawHome, ".openclaw", "extensions", "openclaw-trajectory");
const extensionManifestPath = join(extensionDir, "openclaw.plugin.json");
const packageVersion = JSON.parse(await readFile(join(sourceToolkit, "package.json"), "utf8")).version ?? null;

await assertToolkit(sourceToolkit);
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
    `import register from ${JSON.stringify(pathToFileURL(join(sourceToolkit, "dist", "openclaw-plugin.js")).href)};`,
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
          default: join(openclawHome, ".openclaw", "trajectory"),
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

console.log(
  stableStringify({
    status: "installed",
    source_toolkit: sourceToolkit,
    openclaw_home: openclawHome,
    openclaw_extension_dir: extensionDir,
    openclaw_plugin_manifest: extensionManifestPath,
    version: packageVersion,
    openclaw_install_command: `openclaw plugins install --link "${extensionDir}"`,
    openclaw_allow_conversation_access_command: `openclaw config set plugins.entries.openclaw-trajectory.hooks.allowConversationAccess true`,
    openclaw_allowlist_note: "If plugins.allow is non-empty, add openclaw-trajectory to that allowlist before restarting the gateway."
  })
);

async function assertToolkit(root) {
  await access(join(root, "package.json"), constants.R_OK);
  await access(join(root, "dist", "openclaw-plugin.js"), constants.R_OK);
}

function requiredOption(options, key) {
  const value = options[key];
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
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
