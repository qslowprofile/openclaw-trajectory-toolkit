import { homedir } from "node:os";
import { join } from "node:path";
import { createOpenClawTrajectoryPlugin } from "./plugin.js";
export async function registerOpenClawTrajectory(options = {}) {
    const baseDir = options.baseDir ?? process.env.OPENCLAW_TRAJECTORY_BASE_DIR ?? join(homedir(), ".openclaw", "trajectory");
    const input = options.input ?? process.env.OPENCLAW_TRAJECTORY_INPUT ?? "OpenClaw runtime session";
    const plugin = createOpenClawTrajectoryPlugin({
        ...options,
        baseDir,
        input,
        captureSource: options.captureSource ?? "native_hook"
    });
    return plugin.setup(options.runtime ?? globalRuntime());
}
function globalRuntime() {
    const candidate = globalThis.openclaw ??
        globalThis.OpenClaw;
    return candidate && typeof candidate === "object" ? candidate : null;
}
//# sourceMappingURL=register.js.map