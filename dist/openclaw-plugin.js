import { registerOpenClawNativeTrajectory } from "./openclaw-native.js";
export { OpenClawNativeTrajectoryCollector, registerOpenClawNativeTrajectory } from "./openclaw-native.js";
export default function register(api) {
    const collector = registerOpenClawNativeTrajectory(api);
    collector.attachDiagnostics(api.diagnostics);
    void loadOpenClawDiagnostics().then((diagnostics) => {
        if (diagnostics) {
            collector.attachDiagnostics(diagnostics);
            api.logger?.debug?.("OpenClaw trajectory diagnostics SDK detected after synchronous hook registration.");
        }
    });
}
async function loadOpenClawDiagnostics() {
    try {
        const dynamicImport = new Function("specifier", "return import(specifier)");
        const module = (await dynamicImport("openclaw/plugin-sdk"));
        const diagnostics = {};
        if (typeof module.onDiagnosticEvent === "function") {
            diagnostics.onDiagnosticEvent = module.onDiagnosticEvent;
        }
        if (typeof module.onExternalRequestDiagnosticEvent === "function") {
            diagnostics.onExternalRequestDiagnosticEvent = module.onExternalRequestDiagnosticEvent;
        }
        if (diagnostics.onDiagnosticEvent || diagnostics.onExternalRequestDiagnosticEvent)
            return diagnostics;
    }
    catch {
        return undefined;
    }
    return undefined;
}
//# sourceMappingURL=openclaw-plugin.js.map