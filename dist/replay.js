import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore, stableStringify } from "./artifact-store.js";
export async function createReplayPlan(runDir, mode = "read_only", options = {}) {
    const trajectory = JSON.parse(await readFile(join(runDir, "trajectory.json"), "utf8"));
    const artifactStore = new ArtifactStore(join(runDir, "artifacts"));
    const steps = trajectory.agent_steps.flatMap((agentStep) => agentStep.steps);
    const planSteps = [];
    const missingArtifacts = [];
    for (const step of steps) {
        const missing = await missingArtifactRefs(step, artifactStore);
        missingArtifacts.push(...missing);
        planSteps.push({
            step_id: step.id,
            type: step.type,
            name: step.name,
            action: mode === "mock" ? "mock" : "inspect",
            input_ref: stringOrNull(step.metadata.input_ref),
            output_ref: stringOrNull(step.metadata.output_ref),
            missing_artifacts: missing
        });
    }
    const plan = {
        mode,
        run_id: trajectory.run_id,
        steps: planSteps,
        missing_artifacts: missingArtifacts
    };
    if (options.write ?? true) {
        await writeFile(join(runDir, "replay_meta.json"), `${stableStringify(plan)}\n`, "utf8");
    }
    return plan;
}
export async function findMissingArtifacts(runDir) {
    try {
        const plan = await createReplayPlan(runDir, "read_only", { write: false });
        return plan.missing_artifacts;
    }
    catch {
        return [];
    }
}
async function missingArtifactRefs(step, artifactStore) {
    const refs = [stringOrNull(step.metadata.input_ref), stringOrNull(step.metadata.output_ref)].filter((value) => value !== null);
    const missing = [];
    for (const ref of refs) {
        try {
            await access(await artifactStore.safePathFromUri(ref));
        }
        catch {
            missing.push(ref);
        }
    }
    return missing;
}
function stringOrNull(value) {
    return typeof value === "string" ? value : null;
}
//# sourceMappingURL=replay.js.map