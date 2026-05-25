import { TrajectoryHookManager } from "./hooks.js";
const supportedHooks = ["run", "session", "model", "tool", "message", "skill", "shell", "file", "mcp", "state", "subagent", "compaction"];
export function createOpenClawTrajectoryPlugin(options) {
    return {
        name: "openclaw-trajectory",
        version: "openclaw.trajectory-plugin/v1",
        supported_hooks: supportedHooks,
        async setup(runtime) {
            const manager = await TrajectoryHookManager.startRun(options);
            const registered = await registerHooks(runtime, manager);
            return {
                mode: registered ? "native" : "sdk",
                manager,
                supported_hooks: supportedHooks
            };
        }
    };
}
async function registerHooks(runtime, manager) {
    if (!runtime)
        return false;
    if (typeof runtime.registerTrajectoryHooks === "function") {
        await runtime.registerTrajectoryHooks(manager);
        return true;
    }
    if (typeof runtime.hooks?.registerTrajectoryHooks === "function") {
        await runtime.hooks.registerTrajectoryHooks(manager);
        return true;
    }
    return false;
}
//# sourceMappingURL=plugin.js.map