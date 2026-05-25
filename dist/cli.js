#!/usr/bin/env node
import { access, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { Ajv as AjvClass } from "ajv/dist/ajv.js";
import { createZipFromDirectory } from "./archive.js";
import { summaryCacheFromUri } from "./artifact-store.js";
import { evaluateTrajectory, writeEvaluationResults } from "./evaluators.js";
import { createSafeHttpLlmClient } from "./http-llm.js";
import { appendManualNote, appendManualStructuredEvent, activeRecordingPath, activeSessionRecordingPath, manualRecordingStatus, recoverManualRecording, reconstructManualRecording, reconstructSessionRecording, startManualRecording, stopManualRecording, structuredInputToRecordEvent } from "./manual.js";
import { normalizeRun } from "./normalizer.js";
import { OpenClawNativeTrajectoryCollector } from "./openclaw-native.js";
import { readOpenClawPluginRegistry } from "./openclaw-registry.js";
import { exportOtelSpans } from "./otel.js";
import { appendRunDirectoryEvent, finalizeRunDirectory, TrajectoryRecorder } from "./recorder.js";
import { createReplayPlan, findMissingArtifacts } from "./replay.js";
import { parseDuration } from "./utils.js";
export async function runCli(argv, io = defaultIo) {
    const [command, ...rest] = argv;
    const options = parseOptions(rest);
    try {
        if (command === "version" || command === "--version" || command === "-v") {
            const version = await packageVersion();
            io.stdout(options["json"] === "true" ? JSON.stringify({ version, node: process.version, platform: process.platform, arch: process.arch }) : version);
            return 0;
        }
        if (!command || command === "help" || command === "--help") {
            io.stdout(await usage(rest[0]));
            return 0;
        }
        if (command === "init-run") {
            const baseDir = requireOption(options, "base-dir");
            const input = options["input"] ?? "";
            const recorder = await TrajectoryRecorder.start({
                baseDir,
                input,
                metadata: { source: "openclaw-trajectory-cli" },
                artifactStore: await artifactStoreOptions(options)
            });
            const stats = await recorder.stats();
            await recorder.releasePidFile();
            io.stdout(JSON.stringify({ run_id: recorder.runId, run_dir: recorder.runDir, ...stats }));
            return 0;
        }
        if (command === "record-sample") {
            const baseDir = requireOption(options, "base-dir");
            const recorder = await TrajectoryRecorder.start({
                baseDir,
                input: "Inspect package and run tests",
                metadata: { source: "openclaw-trajectory-cli" },
                sessionId: "sample_session",
                artifactStore: await artifactStoreOptions(options)
            });
            const sample = await readFile(new URL("../examples/sample-run.jsonl", import.meta.url), "utf8");
            await ingestRecordLines(recorder, sample.split("\n"), true, io, options);
            await recorder.finalize({ output: "Sample run completed", status: "ok" });
            const trajectory = await normalizeRun(recorder.runDir, { artifactMode: artifactModeOption(options), inferSpecs: options["infer-specs"] === "true" });
            if (options["with-eval"] === "true") {
                const results = evaluateTrajectory(trajectory);
                await writeEvaluationResults(recorder.runDir, results);
            }
            await runPostProcessing(recorder.runDir, options);
            io.stdout(JSON.stringify({ run_id: recorder.runId, run_dir: recorder.runDir, ...(await recorder.stats()) }));
            return 0;
        }
        if (command === "record") {
            const baseDir = requireOption(options, "base-dir");
            const input = options["input"] ?? "";
            const finalOutput = options["final-output"] ?? "recorded";
            const recorder = await TrajectoryRecorder.start({
                baseDir,
                input,
                metadata: { source: "external-jsonl" },
                artifactStore: await artifactStoreOptions(options)
            });
            const strict = options["strict"] === "true";
            await ingestRecordLines(recorder, inputLines(io), strict, io, options);
            await recorder.finalize({ output: finalOutput, status: "ok" });
            const trajectory = await normalizeRun(recorder.runDir, { artifactMode: artifactModeOption(options), inferSpecs: options["infer-specs"] === "true" });
            if (options["with-eval"] === "true") {
                const results = evaluateTrajectory(trajectory);
                await writeEvaluationResults(recorder.runDir, results);
            }
            await runPostProcessing(recorder.runDir, options);
            io.stdout(JSON.stringify({ run_id: recorder.runId, run_dir: recorder.runDir, ...(await recorder.stats()) }));
            return 0;
        }
        if (command === "import-message-log") {
            const baseDir = requireOption(options, "base-dir");
            const logPath = requireOption(options, "log");
            const result = await importHookSnapshot({ baseDir, logPath, options, io, schemaVersion: "openclaw.trajectory-message-log-import/v1", source: "message_log" });
            io.stdout(JSON.stringify(result));
            return 0;
        }
        if (command === "manual-start" || command === "attach") {
            const baseDir = requireOption(options, "base-dir");
            if (command === "attach" && !options["session-id"]) {
                throw new Error("Missing required option --session-id");
            }
            const active = await startManualRecording({
                baseDir,
                input: options["input"] ?? "",
                trigger: options["trigger"] ?? null,
                sessionId: options["session-id"] ?? null,
                sessionKey: options["session-key"] ?? null,
                agentId: options["agent-id"] ?? null,
                agentName: options["agent"] ?? options["agent-name"] ?? null,
                force: options["force"] === "true",
                artifactStore: await artifactStoreOptions(options)
            });
            io.stdout(JSON.stringify({
                run_id: active.run_id,
                run_dir: active.run_dir,
                mode: active.mode,
                session_id: active.session_id,
                active_path: active.session_id ? activeSessionRecordingPath(baseDir, active.session_id) : activeRecordingPath(baseDir)
            }));
            return 0;
        }
        if (command === "manual-note") {
            const baseDir = requireOption(options, "base-dir");
            const text = await manualTextInput(options, io);
            const result = await appendManualNote({
                baseDir,
                text,
                type: options["type"] ?? null,
                status: options["status"] ?? null,
                stepId: options["step-id"] ?? null,
                timestamp: options["timestamp"] ?? null,
                sessionId: options["session-id"] ?? null,
                agentName: options["agent"] ?? options["agent-name"] ?? null,
                artifactStore: await artifactStoreOptions(options)
            });
            const ids = result.event.ids;
            io.stdout(JSON.stringify({
                run_id: result.active.run_id,
                run_dir: result.active.run_dir,
                event_id: result.event.event_id,
                step_id: ids.step_id ?? null,
                note_type: result.note_type,
                note_count: result.active.note_count
            }));
            return 0;
        }
        if (command === "record-event") {
            const structured = await structuredJsonInput(options, io);
            const artifactStore = await artifactStoreOptions(options);
            if (options["run-dir"]) {
                const event = await appendRunDirectoryEvent(options["run-dir"], structuredInputToRecordEvent(structured), { artifactStore });
                io.stdout(JSON.stringify({ run_id: event.ids.run_id, run_dir: options["run-dir"], event_id: event.event_id, step_id: event.ids.step_id ?? null }));
                return 0;
            }
            const baseDir = requireOption(options, "base-dir");
            const result = await appendManualStructuredEvent({
                baseDir,
                value: structured,
                sessionId: options["session-id"] ?? null,
                artifactStore
            });
            const ids = result.event.ids;
            io.stdout(JSON.stringify({
                run_id: result.active.run_id,
                run_dir: result.active.run_dir,
                event_id: result.event.event_id,
                step_id: ids.step_id ?? null,
                event_type: result.event_type,
                note_count: result.active.note_count
            }));
            return 0;
        }
        if (command === "manual-status") {
            const baseDir = requireOption(options, "base-dir");
            io.stdout(JSON.stringify(await manualRecordingStatus(baseDir, options["session-id"] ?? null)));
            return 0;
        }
        if (command === "manual-stop" || command === "detach") {
            const baseDir = requireOption(options, "base-dir");
            if (command === "detach" && !options["session-id"]) {
                throw new Error("Missing required option --session-id");
            }
            const status = finalStatusOption(options, "ok");
            const finalOutput = options["final-output"] ?? options["output"] ?? "recorded";
            const active = await stopManualRecording({
                baseDir,
                finalOutput,
                status,
                sessionId: options["session-id"] ?? null,
                artifactStore: await artifactStoreOptions(options)
            });
            const trajectory = await normalizeRun(active.run_dir, { artifactMode: artifactModeOption(options), inferSpecs: options["infer-specs"] === "true" });
            if (options["with-eval"] === "true") {
                const results = evaluateTrajectory(trajectory);
                await writeEvaluationResults(active.run_dir, results);
            }
            await runPostProcessing(active.run_dir, options);
            const validate = await validateRunDir(active.run_dir);
            io.stdout(JSON.stringify({ run_id: active.run_id, run_dir: active.run_dir, status, trajectory: `${active.run_dir}/trajectory.json`, validate }));
            return validate.ok ? 0 : 1;
        }
        if (command === "manual-recover") {
            const baseDir = requireOption(options, "base-dir");
            const status = finalStatusOption(options, "ok");
            const finalOutput = options["final-output"] ?? options["output"] ?? "recovered";
            const active = await recoverManualRecording({
                baseDir,
                finalOutput,
                status,
                sessionId: options["session-id"] ?? null,
                artifactStore: await artifactStoreOptions(options)
            });
            if (!active) {
                io.stdout(JSON.stringify({ active: false, recovered: false, base_dir: baseDir }));
                return 0;
            }
            await normalizeRun(active.run_dir, { artifactMode: artifactModeOption(options), inferSpecs: options["infer-specs"] === "true" });
            await runPostProcessing(active.run_dir, options);
            const validate = await validateRunDir(active.run_dir);
            io.stdout(JSON.stringify({ active: false, recovered: true, run_id: active.run_id, run_dir: active.run_dir, validate }));
            return validate.ok ? 0 : 1;
        }
        if (command === "reconstruct") {
            const baseDir = requireOption(options, "base-dir");
            const transcriptPath = options["transcript"] ?? options["input-file"];
            if (!transcriptPath)
                throw new Error("Missing required option --transcript");
            const transcript = await readFile(transcriptPath, "utf8");
            const result = await reconstructManualRecording({
                baseDir,
                transcript,
                input: options["input"] ?? undefined,
                finalOutput: options["final-output"] ?? undefined,
                sessionId: options["session-id"] ?? null,
                artifactStore: await artifactStoreOptions(options)
            });
            const trajectory = await normalizeRun(result.run_dir, { artifactMode: artifactModeOption(options), inferSpecs: options["infer-specs"] === "true" });
            if (options["with-eval"] === "true") {
                const results = evaluateTrajectory(trajectory);
                await writeEvaluationResults(result.run_dir, results);
            }
            await runPostProcessing(result.run_dir, options);
            const validate = await validateRunDir(result.run_dir);
            io.stdout(JSON.stringify({ ...result, trajectory: `${result.run_dir}/trajectory.json`, validate }));
            return validate.ok ? 0 : 1;
        }
        if (command === "reconstruct-session") {
            const baseDir = requireOption(options, "base-dir");
            const locatedSession = await resolveSessionLogInput(options);
            const sessionPath = locatedSession.path;
            const sessionLog = await readFile(sessionPath, "utf8");
            const finalStatus = optionalFinalStatusOption(options);
            const result = await reconstructSessionRecording({
                baseDir,
                sessionLog,
                input: options["input"] ?? undefined,
                finalOutput: options["final-output"] ?? undefined,
                sessionId: options["session-id"] ?? null,
                startTime: options["start-time"] ?? options["since"] ?? null,
                endTime: options["end-time"] ?? options["until"] ?? null,
                detectWindow: options["detect-window"] !== "false",
                excludeSelf: options["exclude-self"] !== "false",
                taskCompleted: booleanOption(options["task-completed"]),
                ...(finalStatus ? { finalStatus } : {}),
                artifactStore: await artifactStoreOptions(options)
            });
            const trajectory = await normalizeRun(result.run_dir, { artifactMode: artifactModeOption(options), inferSpecs: options["infer-specs"] === "true" });
            if (options["with-eval"] === "true") {
                const results = evaluateTrajectory(trajectory);
                await writeEvaluationResults(result.run_dir, results);
            }
            await runPostProcessing(result.run_dir, options);
            const validate = await validateRunDir(result.run_dir);
            io.stdout(JSON.stringify({
                ...result,
                session_path: sessionPath,
                agent_id: locatedSession.agentId,
                trajectory: `${result.run_dir}/trajectory.json`,
                reconstruction_report: `${result.run_dir}/reconstruction_report.json`,
                validate
            }));
            return validate.ok ? 0 : 1;
        }
        if (command === "stop-and-reconstruct") {
            const baseDir = requireOption(options, "base-dir");
            const sessionPath = options["session"] ?? options["session-log"] ?? options["input-file"];
            if (!sessionPath)
                throw new Error("Missing required option --session");
            const sessionLog = await readFile(sessionPath, "utf8");
            const finalStatus = optionalFinalStatusOption(options);
            const result = await reconstructSessionRecording({
                baseDir,
                sessionLog,
                input: options["input"] ?? undefined,
                finalOutput: options["final-output"] ?? undefined,
                sessionId: options["session-id"] ?? null,
                startTime: options["start-time"] ?? options["since"] ?? null,
                endTime: options["end-time"] ?? options["until"] ?? null,
                detectWindow: options["detect-window"] !== "false",
                excludeSelf: options["exclude-self"] !== "false",
                taskCompleted: booleanOption(options["task-completed"]),
                ...(finalStatus ? { finalStatus } : {}),
                artifactStore: await artifactStoreOptions(options)
            });
            const trajectory = await normalizeRun(result.run_dir, { artifactMode: artifactModeOption(options), inferSpecs: options["infer-specs"] === "true" });
            if (options["with-eval"] === "true") {
                const results = evaluateTrajectory(trajectory);
                await writeEvaluationResults(result.run_dir, results);
            }
            await runPostProcessing(result.run_dir, options);
            const validate = await validateRunDir(result.run_dir);
            const reportPath = `${result.run_dir}/reconstruction_report.json`;
            const report = JSON.parse(await readFile(reportPath, "utf8"));
            const sessionId = options["session-id"] ?? null;
            if (sessionId) {
                await rm(activeSessionRecordingPath(baseDir, sessionId), { force: true });
            }
            else {
                await rm(activeRecordingPath(baseDir), { force: true });
            }
            const packageDir = resolve(options["package-dir"] ?? join(baseDir, "packages"));
            const evidencePackage = join(packageDir, `trajectory-run-${result.run_id}.zip`);
            const archive = await createZipFromDirectory(result.run_dir, evidencePackage);
            io.stdout(JSON.stringify({
                ...result,
                trajectory: `${result.run_dir}/trajectory.json`,
                reconstruction_report: reportPath,
                evidence_package: evidencePackage,
                evidence_package_files: archive.file_count,
                evaluation_readiness: report.evaluation_readiness ?? "not_ready",
                readiness_reasons: report.readiness_reasons ?? [],
                quality: report.quality ?? "low",
                validate
            }));
            return validate.ok ? 0 : 1;
        }
        if (command === "normalize") {
            const runDir = requireOption(options, "run-dir");
            const trajectory = await normalizeRun(runDir, { artifactMode: artifactModeOption(options), childClamp: childClampOption(options), inferSpecs: options["infer-specs"] === "true" });
            io.stdout(JSON.stringify({ run_id: trajectory.run_id, trajectory: `${runDir}/trajectory.json` }));
            return 0;
        }
        if (command === "eval") {
            const runDir = requireOption(options, "run-dir");
            const trajectory = await readTrajectory(runDir);
            const results = evaluateTrajectory(trajectory);
            await writeEvaluationResults(runDir, results, { append: options["append"] === "true" });
            io.stdout(JSON.stringify({ run_id: trajectory.run_id, evaluators: results.length, evals: `${runDir}/evals.jsonl` }));
            return 0;
        }
        if (command === "list") {
            const baseDir = requireOption(options, "base-dir");
            const status = options["status"];
            let runs = await listRuns(baseDir);
            if (status)
                runs = runs.filter((run) => run.status === status);
            const since = options["since"] ? Date.parse(options["since"]) : 0;
            if (Number.isFinite(since) && since > 0)
                runs = runs.filter((run) => Date.parse(String(run.started_at ?? "0")) >= since);
            const sortKey = options["sort"] ?? "started_at";
            const order = options["order"] === "asc" ? 1 : -1;
            runs.sort((left, right) => order * compareRunField(left[sortKey], right[sortKey], sortKey));
            const limit = Math.max(0, Number(options["limit"] ?? 50));
            const offset = Math.max(0, Number(options["offset"] ?? 0));
            io.stdout(JSON.stringify({ base_dir: baseDir, count: runs.length, limit, offset, runs: runs.slice(offset, offset + limit) }));
            return 0;
        }
        if (command === "show") {
            const runDir = options["run-dir"] ?? (options["base-dir"] && options["run-id"] ? join(options["base-dir"], "runs", options["run-id"]) : "");
            if (!runDir)
                throw new Error("Missing required option --run-dir or --base-dir with --run-id");
            io.stdout(JSON.stringify(await showRun(runDir)));
            return 0;
        }
        if (command === "status") {
            const home = resolve(options["home"] ?? homedir());
            const openclawHome = resolve(options["openclaw-home"] ?? home);
            const baseDir = resolve(options["base-dir"] ?? join(home, ".openclaw", "trajectory"));
            const runs = await listRuns(baseDir);
            io.stdout(JSON.stringify({
                version: await packageVersion(),
                home,
                openclaw_home: openclawHome,
                base_dir: baseDir,
                run_count: runs.length,
                latest_run: runs[0] ?? null,
                plugin: await pluginInstallStatus(home, openclawHome)
            }));
            return 0;
        }
        if (command === "doctor") {
            const baseDir = requireOption(options, "base-dir");
            const report = await doctorBaseDir(baseDir, options);
            io.stdout(JSON.stringify(report));
            return report.status === "error" ? 1 : 0;
        }
        if (command === "recover") {
            const runDir = requireOption(options, "run-dir");
            const result = await TrajectoryRecorder.recoverRunDir(runDir, { verifyTail: options["verify-tail"] !== "false" });
            let normalized = false;
            let normalizeError = null;
            if (options["normalize"] !== "false") {
                try {
                    await normalizeRun(runDir, { artifactMode: artifactModeOption(options), childClamp: childClampOption(options), inferSpecs: options["infer-specs"] === "true" });
                    normalized = true;
                }
                catch (error) {
                    normalizeError = error instanceof Error ? error.message : String(error);
                }
            }
            io.stdout(JSON.stringify({ run_dir: runDir, recovered: true, ...result, normalized, normalize_error: normalizeError }));
            return 0;
        }
        if (command === "prune") {
            const baseDir = requireOption(options, "base-dir");
            const olderThanMs = parseDuration(options["older-than"] ?? "30d");
            const staleAfterMs = parseDuration(options["stale-after"] ?? "1h");
            const includeStale = options["include-stale"] === "true";
            const dryRun = options["dry-run"] === "true";
            const cutoff = Date.now() - olderThanMs;
            const staleCutoff = Date.now() - staleAfterMs;
            const targets = [];
            for (const run of await listRuns(baseDir)) {
                if (run.ended_at && Date.parse(String(run.ended_at)) < cutoff) {
                    targets.push(run);
                    continue;
                }
                const stale = includeStale &&
                    run.status === "running" &&
                    run.last_event_at !== null &&
                    run.last_event_at !== undefined &&
                    Date.parse(String(run.last_event_at)) < staleCutoff;
                if (stale && !(await hasActivePidFile(String(run.run_dir)))) {
                    targets.push(run);
                }
            }
            if (!dryRun) {
                for (const run of targets) {
                    await rm(String(run.run_dir), { recursive: true, force: true });
                }
            }
            io.stdout(JSON.stringify({ base_dir: baseDir, pruned: targets.length, dry_run: dryRun, runs: targets }));
            return 0;
        }
        if (command === "validate") {
            const runDir = requireOption(options, "run-dir");
            const result = await validateRunDir(runDir);
            io.stdout(JSON.stringify(result));
            return result.ok ? 0 : 1;
        }
        if (command === "quality") {
            const runDir = requireOption(options, "run-dir");
            io.stdout(JSON.stringify(await qualityReport(runDir)));
            return 0;
        }
        if (command === "quicktest") {
            const baseDir = requireOption(options, "base-dir");
            const result = await runQuicktest(baseDir, options);
            if (options["json"] === "true") {
                io.stdout(JSON.stringify(result));
            }
            else {
                io.stdout(`quicktest ${result.status}: ${result.run_dir}`);
            }
            return result.validate.ok ? 0 : 1;
        }
        if (command === "finalize") {
            const runDir = requireOption(options, "run-dir");
            const status = (options["status"] ?? "ok");
            const output = options["output"] ?? "";
            const event = await finalizeRunDirectory(runDir, { output, status, artifactStore: await artifactStoreOptions(options) });
            io.stdout(JSON.stringify({ run_id: event.ids.run_id, run_dir: runDir, status }));
            return 0;
        }
        if (command === "replay") {
            const runDir = requireOption(options, "run-dir");
            const mode = (options["mode"] ?? "read_only");
            const plan = await createReplayPlan(runDir, mode);
            io.stdout(JSON.stringify({ run_id: plan.run_id, mode: plan.mode, missing_artifacts: plan.missing_artifacts.length }));
            return 0;
        }
        if (command === "export") {
            const runDir = requireOption(options, "run-dir");
            const format = options["format"] ?? "otel";
            if (format === "otel") {
                const spans = await exportOtelSpans(runDir);
                io.stdout(JSON.stringify({ spans: spans.length, output: `${runDir}/spans.otlp.jsonl` }));
                return 0;
            }
            if (format === "trajectory") {
                io.stdout(await readFile(`${runDir}/trajectory.json`, "utf8"));
                return 0;
            }
            throw new Error(`Unsupported export format: ${format}`);
        }
        if (command === "tail") {
            const runDir = requireOption(options, "run-dir");
            const lines = Math.max(1, Number(options["lines"] ?? 20));
            const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
            for (const line of raw.split("\n").filter(Boolean).slice(-lines)) {
                io.stdout(line);
            }
            return 0;
        }
        if (command === "stitch") {
            const runDir = requireOption(options, "run-dir");
            const followChildren = options["follow-children"] === "true";
            const stitched = await stitchRunTree(runDir, { followChildren });
            const output = options["output"];
            if (output) {
                await writeFile(output, `${JSON.stringify(stitched)}\n`, "utf8");
                io.stdout(JSON.stringify({ output, run_count: stitched.run_count }));
            }
            else {
                io.stdout(JSON.stringify(stitched));
            }
            return 0;
        }
        if (command === "import-openclaw-bundle") {
            const baseDir = requireOption(options, "base-dir");
            const bundleDir = requireOption(options, "bundle-dir");
            const logPath = await resolveOpenClawBundleHookLog(bundleDir);
            const result = await importHookSnapshot({ baseDir, logPath, options, io, schemaVersion: "openclaw.trajectory-bundle-import/v1", source: "openclaw_bundle" });
            io.stdout(JSON.stringify({ ...result, bundle_dir: bundleDir }));
            return 0;
        }
        if (command === "compare-openclaw-bundle") {
            const runDir = requireOption(options, "run-dir");
            const bundleDir = requireOption(options, "bundle-dir");
            io.stdout(JSON.stringify(await compareOpenClawBundle(runDir, bundleDir)));
            return 0;
        }
        if (command === "merge") {
            const rawRunDirs = requireOption(options, "run-dirs");
            const output = requireOption(options, "output");
            const mode = mergeModeOption(options);
            const runDirs = rawRunDirs.split(",").map((item) => item.trim()).filter(Boolean);
            const maxRuns = positiveIntegerOption(options, "max-runs", 100);
            if (runDirs.length > maxRuns) {
                throw new Error(`Too many runs for merge: ${runDirs.length}. Increase --max-runs to continue.`);
            }
            const canonicalRunDirs = await Promise.all(runDirs.map(async (runDir) => ({ input: runDir, canonical: await realpath(resolve(runDir)) })));
            const seenRunDirs = new Set();
            for (const runDir of canonicalRunDirs) {
                if (seenRunDirs.has(runDir.canonical)) {
                    throw new Error(`Duplicate run directory in merge input: ${runDir.input}`);
                }
                seenRunDirs.add(runDir.canonical);
            }
            const trajectories = await Promise.all(canonicalRunDirs.map((runDir) => readTrajectory(runDir.input)));
            const seenRunIds = new Set();
            for (const trajectory of trajectories) {
                if (seenRunIds.has(trajectory.run_id)) {
                    throw new Error(`Duplicate run_id in merge input: ${trajectory.run_id}`);
                }
                seenRunIds.add(trajectory.run_id);
            }
            const merged = {
                schema_version: "openclaw.trajectory-merge/v1",
                generated_at: new Date().toISOString(),
                mode,
                run_count: trajectories.length,
                warnings: [],
                runs: trajectories.map((trajectory) => ({
                    run_id: trajectory.run_id,
                    trace_id: trajectory.trace_id,
                    status: trajectory.root_step.basic_info.status,
                    started_at: trajectory.root_step.basic_info.started_at,
                    duration_ms: trajectory.root_step.basic_info.duration_ms,
                    metrics_info: trajectory.root_step.metrics_info,
                    ...(mode === "full" ? { trajectory } : {})
                }))
            };
            await writeFile(output, `${JSON.stringify(merged)}\n`, "utf8");
            io.stdout(JSON.stringify({ output, run_count: trajectories.length, mode }));
            return 0;
        }
        throw new Error(`Unknown command: ${command}`);
    }
    catch (error) {
        io.stderr(friendlyErrorMessage(error));
        return 1;
    }
}
function parseOptions(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token?.startsWith("--"))
            continue;
        const eqIndex = token.indexOf("=");
        if (eqIndex > 2) {
            options[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
            continue;
        }
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
            options[key] = "true";
            continue;
        }
        options[key] = next;
        index += 1;
    }
    return options;
}
function mapMessageLoggerHook(hookType) {
    const native = new Set([
        "message_received",
        "session_start",
        "before_model_resolve",
        "before_prompt_build",
        "llm_input",
        "llm_output",
        "before_tool_call",
        "after_tool_call",
        "message_sending",
        "message_sent",
        "agent_end",
        "session_end",
        "before_compaction",
        "after_compaction",
        "run.started",
        "run.completed",
        "run.error",
        "model_call_started",
        "model_call_ended",
        "model.call.started",
        "model.call.completed",
        "model.call.error",
        "tool.execution.started",
        "tool.execution.completed",
        "tool.execution.error",
        "tool.execution.blocked",
        "context.assembled",
        "subagent_spawning",
        "subagent_delivery_target",
        "subagent_spawned",
        "subagent_ended",
        "tool_result_persist",
        "before_message_write"
    ]);
    if (native.has(hookType))
        return { kind: "hook", name: hookType };
    if (hookType === "session_state")
        return { kind: "diagnostic", type: "session.state" };
    if (hookType === "model_usage")
        return { kind: "diagnostic", type: "model.usage" };
    if (hookType === "tool_loop")
        return { kind: "diagnostic", type: "tool.loop" };
    if (hookType === "message_queued")
        return { kind: "diagnostic", type: "message.queued" };
    if (hookType === "message_processed")
        return { kind: "diagnostic", type: "message.processed" };
    if (hookType === "run_attempt")
        return { kind: "diagnostic", type: "run.attempt" };
    if (hookType.startsWith("queue_lane_"))
        return { kind: "diagnostic", type: `queue.lane.${hookType.slice("queue_lane_".length)}` };
    return { kind: "skip" };
}
async function importHookSnapshot(options) {
    const before = new Set((await listRuns(options.baseDir)).map((run) => String(run.run_dir)));
    const collector = new OpenClawNativeTrajectoryCollector({
        pluginConfig: {},
        on: () => undefined,
        logger: {
            info: () => undefined,
            warn: (message) => options.io.stderr(message)
        }
    }, {
        baseDir: options.baseDir,
        finalizeDelayMs: 0,
        normalizeOnFinalize: true,
        startupScavenge: false,
        artifactStore: await artifactStoreOptions(options.options)
    });
    const raw = await readFile(options.logPath, "utf8");
    let importedEvents = 0;
    let skippedEvents = 0;
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
        if (!line.trim())
            continue;
        const event = normalizeImportedHookEvent(parseJsonLine(line, index + 1), options.source);
        const hookType = stringOrUndefined(event.hookType ?? event.type);
        if (!hookType) {
            skippedEvents += 1;
            continue;
        }
        const mapped = mapMessageLoggerHook(hookType);
        if (mapped.kind === "hook") {
            await collector.handleHook(mapped.name, event, event);
            importedEvents += 1;
        }
        else if (mapped.kind === "diagnostic") {
            await collector.handleDiagnosticEvent({ ...event, type: mapped.type });
            importedEvents += 1;
        }
        else {
            skippedEvents += 1;
        }
    }
    await collector.flush();
    const after = (await listRuns(options.baseDir)).filter((run) => !before.has(String(run.run_dir)));
    return {
        schema_version: options.schemaVersion,
        log: options.logPath,
        imported_events: importedEvents,
        skipped_events: skippedEvents,
        run_count: after.length,
        run_dirs: after.map((run) => run.run_dir)
    };
}
function normalizeImportedHookEvent(event, source) {
    const normalized = {
        ...event,
        "openclaw.import_source": source
    };
    const toolName = toolNameAlias(event);
    if (toolName && normalized.toolName === undefined)
        normalized.toolName = toolName;
    const toolCallId = stringOrUndefined(event.toolCallId ?? event.tool_call_id ?? event.callId ?? event.call_id ?? event.id);
    if (toolCallId && normalized.toolCallId === undefined)
        normalized.toolCallId = toolCallId;
    if (normalized.eventAt === undefined) {
        normalized.eventAt = event.ts ?? event.timestamp ?? event.eventTime;
    }
    return normalized;
}
function toolNameAlias(event) {
    return stringOrUndefined(event.toolName ?? event.tool_name ?? event.name ?? objectOrUndefined(event.function)?.name);
}
function coerceRecordEvent(raw, line, strict, io) {
    const ids = raw.ids && typeof raw.ids === "object" ? raw.ids : {};
    const attrs = objectOrUndefined(raw.attrs) ?? {};
    const actor = coerceEnum({
        label: "actor",
        value: raw.actor,
        allowed: validActors,
        fallback: "agent",
        line,
        strict,
        io,
        attrs
    });
    const phase = coerceEnum({
        label: "phase",
        value: raw.phase,
        allowed: validPhases,
        fallback: "event",
        line,
        strict,
        io,
        attrs
    });
    const status = coerceEnum({
        label: "status",
        value: raw.status,
        allowed: validStatuses,
        fallback: "ok",
        line,
        strict,
        io,
        attrs
    });
    const event = {
        kind: String(raw.kind ?? ""),
        actor: actor,
        phase: phase,
        status: status
    };
    assignOptional(event, "timestamp", stringOrUndefined(raw.timestamp));
    assignOptional(event, "parent_span_id", nullableString(raw.parent_span_id ?? ids.parent_span_id));
    assignOptional(event, "span_id", coerceId("span_id", raw.span_id ?? ids.span_id, /^[A-Fa-f0-9]{16}$/, line, strict, io));
    assignOptional(event, "step_id", coerceId("step_id", raw.step_id ?? ids.step_id, /^step_[A-Za-z0-9._-]+$/, line, strict, io));
    assignOptional(event, "tool_call_id", coerceNullableId("tool_call_id", raw.tool_call_id ?? ids.tool_call_id, /^[A-Za-z0-9._-]+$/, line, strict, io));
    assignOptional(event, "skill_invocation_id", coerceNullableId("skill_invocation_id", raw.skill_invocation_id ?? ids.skill_invocation_id, /^[A-Za-z0-9._-]+$/, line, strict, io));
    assignOptional(event, "turn_id", coerceNullableId("turn_id", raw.turn_id ?? ids.turn_id, /^[A-Za-z0-9._-]+$/, line, strict, io));
    assignOptional(event, "attrs", attrs);
    if ("input" in raw)
        event.input = raw.input;
    if ("output" in raw)
        event.output = raw.output;
    if ("error" in raw)
        event.error = raw.error;
    return event;
}
async function ingestRecordLines(recorder, lines, strict, io, options) {
    let lineNo = 0;
    const showProgress = options["progress"] === "true";
    for await (const line of lines) {
        lineNo += 1;
        if (line.trim().length === 0)
            continue;
        const event = coerceRecordEvent(parseJsonLine(line, lineNo), lineNo, strict, io);
        validateExternalCorrelation(event, lineNo, strict, io);
        await recorder.record(event);
        if (showProgress && lineNo % 1000 === 0) {
            const stats = await recorder.stats();
            io.stderr(`processed ${lineNo} lines, ${stats.events_written} events written`);
        }
    }
}
const validActors = ["runtime", "agent", "model", "skill", "tool", "mcp", "file", "shell", "state", "artifact", "evaluator"];
const validPhases = ["start", "end", "event"];
const validStatuses = ["ok", "error", "cancelled", "timeout", "running"];
function parseJsonLine(line, lineNo) {
    try {
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("JSONL event must be an object");
        }
        return value;
    }
    catch (error) {
        throw new Error(`Line ${lineNo}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function coerceEnum(options) {
    const raw = String(options.value ?? options.fallback);
    if (options.allowed.includes(raw))
        return raw;
    const message = `Line ${options.line}: invalid ${options.label} "${raw}", coerced to "${options.fallback}".`;
    if (options.strict) {
        throw new Error(message);
    }
    options.io.stderr(`Warning: ${message}`);
    options.attrs[`openclaw.original_${options.label}`] = raw;
    return options.fallback;
}
function coerceId(label, value, pattern, line, strict, io) {
    const text = stringOrUndefined(value);
    if (text === undefined)
        return undefined;
    if (pattern.test(text))
        return text;
    const message = `Line ${line}: invalid ${label} "${text}".`;
    if (strict) {
        throw new Error(message);
    }
    io.stderr(`Warning: ${message} The value was ignored.`);
    return undefined;
}
function coerceNullableId(label, value, pattern, line, strict, io) {
    if (value === null)
        return null;
    return coerceId(label, value, pattern, line, strict, io);
}
function assignOptional(target, key, value) {
    if (value !== undefined) {
        target[key] = value;
    }
}
function validateExternalCorrelation(event, line, strict, io) {
    if (event.kind === "openclaw.request")
        return;
    if (event.phase !== "start" && event.phase !== "end")
        return;
    if (event.span_id || event.step_id || event.tool_call_id || event.skill_invocation_id)
        return;
    const message = `Line ${line}: ${event.kind} ${event.phase} event is missing a stable correlation id; provide span_id, step_id, tool_call_id, or skill_invocation_id to pair start/end events.`;
    if (strict) {
        throw new Error(message);
    }
    io.stderr(`Warning: ${message}`);
}
function stringOrUndefined(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function nullableString(value) {
    if (value === null)
        return null;
    return stringOrUndefined(value);
}
function objectOrUndefined(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function requireOption(options, key) {
    const value = options[key];
    if (!value) {
        throw new Error(`Missing required option --${key}`);
    }
    return value;
}
async function resolveSessionLogInput(options) {
    const explicit = options["session"] ?? options["session-log"] ?? options["input-file"];
    if (explicit)
        return { path: explicit, agentId: null };
    const sessionId = options["session-id"];
    if (!sessionId)
        throw new Error("Missing required option --session or --session-id with --openclaw-home");
    const openclawHome = resolve(options["openclaw-home"] ?? homedir());
    const matches = await findOpenClawSessionLogs(openclawHome, sessionId);
    if (matches.length === 0) {
        throw new Error(`No OpenClaw session log found for session id ${sessionId} under ${openclawHome}`);
    }
    if (matches.length > 1) {
        throw new Error(`Multiple OpenClaw session logs found for session id ${sessionId}: ${matches.map((match) => match.path).join(", ")}`);
    }
    return matches[0];
}
async function findOpenClawSessionLogs(openclawHome, sessionId) {
    const roots = [join(openclawHome, ".openclaw", "agents"), join(openclawHome, "agents")];
    const matches = [];
    for (const root of roots) {
        const agents = await readdir(root, { withFileTypes: true }).catch(() => []);
        for (const agent of agents) {
            if (!agent.isDirectory())
                continue;
            const candidate = join(root, agent.name, "sessions", `${sessionId}.jsonl`);
            try {
                await access(candidate);
                matches.push({ path: candidate, agentId: agent.name });
            }
            catch {
                // keep scanning
            }
        }
    }
    return matches;
}
function positiveIntegerOption(options, key, defaultValue) {
    const raw = options[key];
    if (raw === undefined)
        return defaultValue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Invalid --${key}: expected a positive integer`);
    }
    return value;
}
function finalStatusOption(options, defaultValue) {
    const status = options["final-status"] ?? options["status"] ?? defaultValue;
    if (status === "ok" || status === "error" || status === "cancelled" || status === "timeout")
        return status;
    throw new Error(`Invalid --status: ${status}. Expected ok, error, cancelled, or timeout.`);
}
function optionalFinalStatusOption(options) {
    if (options["final-status"] === undefined && options["status"] === undefined)
        return undefined;
    return finalStatusOption(options, "ok");
}
function booleanOption(value) {
    if (value === undefined)
        return null;
    const normalized = value.toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y")
        return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "n")
        return false;
    throw new Error(`Invalid boolean option: ${value}`);
}
function mergeModeOption(options) {
    const mode = options["mode"] ?? "summary";
    if (mode === "summary" || mode === "full")
        return mode;
    throw new Error(`Invalid --mode: ${mode}. Expected summary or full.`);
}
async function readTrajectory(runDir) {
    return JSON.parse(await readFile(`${runDir}/trajectory.json`, "utf8"));
}
async function qualityReport(runDir) {
    const trajectory = await readTrajectory(runDir);
    const run = await readOptionalJson(join(runDir, "run.json"));
    const normalization = await readOptionalJson(join(runDir, "normalization_report.json"));
    const reconstruction = await readOptionalJson(join(runDir, "reconstruction_report.json"));
    const steps = trajectory.agent_steps.flatMap((agentStep) => agentStep.steps);
    const diagnosticStepCount = trajectory.diagnostic_steps?.length ?? 0;
    const modelSteps = steps.filter((step) => step.type === "model");
    const toolSteps = steps.filter((step) => step.type === "tool" || step.type === "shell" || step.type === "mcp");
    const runMetadata = run?.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata) ? run.metadata : {};
    const rootMetadata = trajectory.root_step.metadata ?? {};
    const reasons = new Set(reconstruction?.readiness_reasons ?? []);
    if (steps.length === 0)
        reasons.add("empty_trajectory");
    if (modelSteps.length === 0)
        reasons.add("missing_model_steps");
    if (toolSteps.length === 0)
        reasons.add("missing_tool_steps");
    if (trajectory.root_step.metrics_info.input_tokens === 0 && trajectory.root_step.metrics_info.output_tokens === 0)
        reasons.add("missing_token_usage");
    if (runMetadata["recording.fidelity"] === "low" ||
        rootMetadata["recording.fidelity"] === "low" ||
        steps.some((step) => step.metadata["recording.fidelity"] === "low")) {
        reasons.add("low_fidelity");
    }
    if (runMetadata["evidence.source"] === "manual_note" ||
        rootMetadata["evidence.source"] === "manual_note" ||
        steps.some((step) => step.metadata["evidence.source"] === "manual_note")) {
        reasons.add("manual_note_evidence");
    }
    if (!rootMetadata["openclaw.session_id"])
        reasons.add("missing_session_identity");
    if (!rootMetadata["openclaw.agent_id"] && !rootMetadata["openclaw.agent_name"] && !rootMetadata["agent.name"])
        reasons.add("missing_agent_identity");
    if (steps.some((step) => step.metadata["openclaw.timestamp.generated"] === true))
        reasons.add("generated_timestamps");
    if ((normalization?.warnings ?? []).some((warning) => warning.code === "missing_start_event"))
        reasons.add("missing_start_events");
    if (steps.some((step) => step.type === "state" && /录制|record|trace|trajectory/i.test(step.name)))
        reasons.add("control_steps_present");
    const evaluationReadiness = reasons.size === 0 ? "ready" : "limited";
    const readinessDimensions = {
        identity_completeness: !reasons.has("missing_session_identity") && !reasons.has("missing_agent_identity") ? "ready" : "limited",
        timing_fidelity: reasons.has("generated_timestamps") || reasons.has("missing_start_events") ? "limited" : "ready",
        model_tool_pairing_accuracy: modelSteps.length > 0 && toolSteps.length > 0 ? "ready" : "limited",
        artifact_redaction_status: steps.some((step) => Array.isArray(step.metadata["openclaw.redacted_attr_keys"])) ? "redacted" : "not_required",
        replayability: (await findMissingArtifacts(runDir)).length === 0 ? "ready" : "limited",
        evaluator_readiness: evaluationReadiness
    };
    return {
        schema_version: "openclaw.trajectory-quality/v1",
        run_id: trajectory.run_id,
        generated_at: new Date().toISOString(),
        evaluation_readiness: evaluationReadiness,
        readiness_dimensions: readinessDimensions,
        reasons: Array.from(reasons).sort(),
        step_count: steps.length,
        diagnostic_step_count: diagnosticStepCount,
        model_step_count: modelSteps.length,
        tool_step_count: toolSteps.length,
        fidelity: runMetadata["recording.fidelity"] ?? rootMetadata["recording.fidelity"] ?? null,
        evidence_source: runMetadata["evidence.source"] ?? rootMetadata["evidence.source"] ?? null
    };
}
async function usage(command) {
    if (command === "record") {
        return [
            "openclaw-trajectory record --base-dir <dir> [--input text] [--final-output text] [--strict] [--with-eval] [--no-replay] [--no-otel] [--llm-summarize=on|off|deterministic] [--llm-max-calls n] [--llm-max-bytes n] [--summary-cache cache://memory|cache:///path] [--infer-specs=true] < events.jsonl",
            "",
            "Each stdin line is JSON with kind, actor, phase, status, attrs, input, output.",
            "For paired start/end events, prefer the same step_id, then tool_call_id, skill_invocation_id, or span_id."
        ].join("\n");
    }
    if (command === "finalize") {
        return "openclaw-trajectory finalize --run-dir <runDir> [--status ok|error|cancelled|timeout] [--output text] [--llm-summarize=on|off|deterministic] [--llm-max-calls n] [--llm-max-bytes n]";
    }
    if (command === "eval") {
        return "openclaw-trajectory eval --run-dir <runDir> [--append]";
    }
    return [
        `openclaw-trajectory <command> (${await packageVersion()})`,
        "",
        "Commands:",
        "  init-run --base-dir <dir> [--input text]",
        "  finalize --run-dir <runDir> [--status ok|error|cancelled|timeout] [--output text]",
        "  record-sample --base-dir <dir> [--with-eval] [--no-replay] [--no-otel] [--llm-summarize=on|off|deterministic] [--llm-max-calls n] [--llm-max-bytes n] [--summary-cache uri] [--infer-specs=true]",
        "  record --base-dir <dir> [--input text] [--final-output text] [--strict] [--with-eval] [--progress] [--llm-summarize=on|off|deterministic] [--infer-specs=true] < events.jsonl",
        "  import-message-log --base-dir <dir> --log <plugin-message-hook.log>",
        "  import-openclaw-bundle --base-dir <dir> --bundle-dir <bundle>",
        "  compare-openclaw-bundle --run-dir <runDir> --bundle-dir <bundle>",
        "  attach --base-dir <dir> --session-id <id> [--input text] [--agent-id id] [--agent name]",
        "  detach --base-dir <dir> --session-id <id> [--final-output text] [--status ok|error|cancelled|timeout]",
        "  manual-start --base-dir <dir> [--session-id id] [--input text] [--trigger text] [--agent name]",
        "  manual-note --base-dir <dir> [--session-id id] [--type model|tool|shell|file|mcp|skill|state|agent] [--status ok|error|cancelled|timeout] [--text text]",
        "  record-event --base-dir <dir> [--session-id id] --json <event-json>",
        "  record-event --run-dir <runDir> --json <event-json>",
        "  manual-stop --base-dir <dir> [--final-output text] [--status ok|error|cancelled|timeout]",
        "  manual-status --base-dir <dir>",
        "  manual-recover --base-dir <dir> [--final-output text] [--status ok|error|cancelled|timeout]",
        "  reconstruct --base-dir <dir> --transcript <path> [--input text] [--final-output text]",
        "  reconstruct-session --base-dir <dir> --session <path> [--start-time iso] [--end-time iso] [--detect-window=false] [--exclude-self=false] [--status ok|error|cancelled|timeout] [--task-completed true|false]",
        "  reconstruct-session --base-dir <dir> --session-id <id> --openclaw-home <home> [--status ok|error|cancelled|timeout]",
        "  stop-and-reconstruct --base-dir <dir> --session <path> [--package-dir <dir>] [--status ok|error|cancelled|timeout] [--task-completed true|false]",
        "  normalize --run-dir <runDir> [--artifact-mode safe|inline|summary|ref] [--child-clamp warn|root|none] [--infer-specs=true]",
        "  eval --run-dir <runDir> [--append]",
        "  replay --run-dir <runDir> [--mode read_only|mock]",
        "  export --run-dir <runDir> [--format otel|trajectory]",
        "  quality --run-dir <runDir>",
        "  quicktest --base-dir <dir> [--json]",
        "  list --base-dir <dir> [--status running|ok|error|cancelled|timeout]",
        "  show --run-dir <runDir>",
        "  status [--home <dir>] [--openclaw-home <dir>] [--base-dir <dir>]",
        "  doctor --base-dir <dir> [--stale-after 1h] [--plugin] [--home <dir>] [--openclaw-home <dir>]",
        "  recover --run-dir <runDir> [--normalize=false]",
        "  tail --run-dir <runDir> [--lines 20]",
        "  stitch --run-dir <rootRun> --follow-children [--output <path>]",
        "  merge --run-dirs <runDirA,runDirB> --output <path> [--mode summary|full] [--max-runs 100]",
        "  prune --base-dir <dir> [--older-than 30d] [--include-stale] [--stale-after 1h] [--dry-run]",
        "  validate --run-dir <runDir>"
    ].join("\n");
}
function friendlyErrorMessage(error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        const path = String(error.path ?? "");
        if (path.endsWith("trajectory.json")) {
            return "Trajectory file is missing. Run `openclaw-trajectory normalize --run-dir <runDir>` first.";
        }
        if (path.endsWith("run.json")) {
            return "Run metadata is missing. Check --run-dir and make sure it points to an OpenClaw trajectory run directory.";
        }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") && message.includes("trajectory.json")) {
        return "Trajectory file is missing. Run `openclaw-trajectory normalize --run-dir <runDir>` first.";
    }
    if (message.includes("ENOENT") && message.includes("run.json")) {
        return "Run metadata is missing. Check --run-dir and make sure it points to an OpenClaw trajectory run directory.";
    }
    return message;
}
const defaultIo = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line)
};
async function* inputLines(io) {
    if (io.stdin) {
        for (const line of (await io.stdin()).split("\n")) {
            yield line;
        }
        return;
    }
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
        yield line;
    }
}
async function manualTextInput(options, io) {
    if (options["text"] !== undefined)
        return options["text"];
    if (options["input-file"])
        return readFile(options["input-file"], "utf8");
    if (io.stdin)
        return io.stdin();
    throw new Error("Missing manual note text. Provide --text, --input-file, or stdin.");
}
async function structuredJsonInput(options, io) {
    const raw = options["json"] ??
        (options["input-file"] ? await readFile(options["input-file"], "utf8") : io.stdin ? await io.stdin() : null);
    if (raw === null) {
        throw new Error("Missing structured event JSON. Provide --json, --input-file, or stdin.");
    }
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`Invalid structured event JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}
async function packageVersion() {
    try {
        const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        return pkg.version ?? "unknown";
    }
    catch {
        return "unknown";
    }
}
async function runPostProcessing(runDir, options) {
    if (options["no-replay"] !== "true") {
        await createReplayPlan(runDir, "mock");
    }
    if (options["no-otel"] !== "true") {
        await exportOtelSpans(runDir);
    }
}
async function artifactStoreOptions(options) {
    const setting = options["llm-summarize"] ?? process.env.OPENCLAW_TRAJECTORY_LLM ?? "deterministic";
    if (setting === "off" || setting === "none") {
        return { summarize: "none" };
    }
    if (setting === "on" || setting === "summary" || setting === "llm") {
        const runtime = await readRuntimeConfig();
        const llm = createEnvLlmClient(runtime);
        const maxCalls = numberOption(options["llm-max-calls"] ?? process.env.OPENCLAW_TRAJECTORY_LLM_MAX_CALLS);
        const maxBytes = numberOption(options["llm-max-bytes"] ?? process.env.OPENCLAW_TRAJECTORY_LLM_MAX_BYTES);
        const cacheUri = options["summary-cache"] ?? process.env.OPENCLAW_TRAJECTORY_SUMMARY_CACHE ?? runtime.summaryCache;
        return {
            summarize: "llm",
            llm,
            summaryModelName: process.env.OPENCLAW_LLM_MODEL ?? runtime.model ?? "openclaw-runtime",
            summaryBudget: { ...(maxCalls !== null ? { maxCalls } : {}), ...(maxBytes !== null ? { maxBytes } : {}) },
            ...(cacheUri ? { summaryCache: summaryCacheFromUri(cacheUri) } : {})
        };
    }
    return { summarize: "deterministic" };
}
function artifactModeOption(options) {
    const mode = options["artifact-mode"] ?? "safe";
    if (["safe", "inline", "summary", "ref"].includes(mode)) {
        return mode;
    }
    throw new Error(`Unsupported artifact mode: ${mode}`);
}
function childClampOption(options) {
    const mode = options["child-clamp"] ?? "warn";
    if (["warn", "root", "none"].includes(mode)) {
        return mode;
    }
    throw new Error(`Unsupported child clamp mode: ${mode}`);
}
function createEnvLlmClient(runtime) {
    const endpoint = process.env.OPENCLAW_LLM_ENDPOINT ?? runtime.endpoint;
    if (!endpoint) {
        throw new Error("LLM summary was requested but no OPENCLAW_LLM_ENDPOINT or runtime.json llm.endpoint is configured.");
    }
    const clientOptions = {
        endpoint,
        model: process.env.OPENCLAW_LLM_MODEL ?? runtime.model ?? null,
        apiKey: process.env.OPENCLAW_LLM_API_KEY ?? runtime.apiKey ?? null
    };
    const timeoutMs = numberOption(process.env.OPENCLAW_LLM_TIMEOUT_MS);
    const maxBytes = numberOption(process.env.OPENCLAW_LLM_MAX_BYTES);
    if (timeoutMs !== null)
        clientOptions.timeoutMs = timeoutMs;
    if (maxBytes !== null)
        clientOptions.maxBytes = maxBytes;
    return createSafeHttpLlmClient(clientOptions);
}
function numberOption(value) {
    if (value === undefined || value.trim() === "")
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
async function readRuntimeConfig() {
    const path = process.env.OPENCLAW_RUNTIME_CONFIG ?? join(homedir(), ".openclaw", "runtime.json");
    try {
        const resolvedPath = await realpath(path);
        await warnIfRuntimeConfigOutsideHome(resolvedPath);
        const raw = JSON.parse(await readFile(resolvedPath, "utf8"));
        if (raw.llm?.transport && raw.llm.transport !== "http") {
            return {};
        }
        const apiKeyEnv = raw.llm?.api_key_env;
        const config = {};
        if (raw.llm?.endpoint)
            config.endpoint = raw.llm.endpoint;
        if (raw.llm?.model)
            config.model = raw.llm.model;
        if (raw.llm?.api_key) {
            process.stderr.write("Warning: runtime.json llm.api_key is ignored. Use llm.api_key_env instead.\n");
        }
        if (raw.llm?.summary_cache)
            config.summaryCache = raw.llm.summary_cache;
        const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
        if (apiKey)
            config.apiKey = apiKey;
        return config;
    }
    catch {
        return {};
    }
}
async function warnIfRuntimeConfigOutsideHome(resolvedPath) {
    if (!process.env.OPENCLAW_RUNTIME_CONFIG)
        return;
    const home = await realpath(homedir()).catch(() => resolve(homedir()));
    const back = relative(home, resolvedPath);
    if (back.startsWith("..") || back === ".." || resolve(back) === back) {
        process.stderr.write("Warning: OPENCLAW_RUNTIME_CONFIG points outside the current user's home directory.\n");
    }
}
async function listRuns(baseDir) {
    const runsPath = join(baseDir, "runs");
    const entries = await readdir(runsPath, { withFileTypes: true }).catch(() => []);
    const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        try {
            const runDir = join(runsPath, entry.name);
            const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
            const trajectory = await readOptionalJson(join(runDir, "trajectory.json"));
            const stepCount = trajectory?.agent_steps.flatMap((agentStep) => agentStep.steps).length ?? 0;
            const diagnosticStepCount = trajectory?.diagnostic_steps?.length ?? 0;
            return {
                run_id: run.run_id,
                run_dir: runDir,
                status: run.status,
                started_at: run.started_at,
                ended_at: run.ended_at ?? null,
                last_event_at: run.last_event_at ?? null,
                step_count: stepCount,
                diagnostic_step_count: diagnosticStepCount,
                artifact_bytes: await artifactBytes(runDir),
                run_dir_bytes: await dirBytes(runDir)
            };
        }
        catch {
            return {
                run_id: entry.name,
                run_dir: join(runsPath, entry.name),
                status: "unreadable"
            };
        }
    }));
    return runs.sort((left, right) => String(right.started_at ?? "").localeCompare(String(left.started_at ?? "")));
}
function compareRunField(left, right, sortKey) {
    if (["run_dir_bytes", "step_count", "diagnostic_step_count", "artifact_bytes"].includes(sortKey)) {
        return Number(left ?? 0) - Number(right ?? 0);
    }
    if (["started_at", "ended_at", "last_event_at"].includes(sortKey)) {
        return Date.parse(String(left ?? "0")) - Date.parse(String(right ?? "0"));
    }
    return String(left ?? "").localeCompare(String(right ?? ""));
}
async function showRun(runDir) {
    try {
        await stat(runDir);
    }
    catch {
        throw new Error(`Run directory not found: ${runDir}`);
    }
    const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
    const trajectory = await readOptionalJson(join(runDir, "trajectory.json"));
    const report = await readOptionalJson(join(runDir, "normalization_report.json"));
    const steps = trajectory?.agent_steps.flatMap((agentStep) => agentStep.steps) ?? [];
    const diagnosticStepCount = trajectory?.diagnostic_steps?.length ?? 0;
    return {
        run_id: run.run_id,
        run_dir: runDir,
        status: run.status,
        started_at: run.started_at,
        ended_at: run.ended_at ?? null,
        last_event_at: run.last_event_at ?? null,
        step_count: steps.length,
        diagnostic_step_count: diagnosticStepCount,
        warning_count: report?.warnings?.length ?? 0,
        warnings: report?.warnings?.map((warning) => warning.code ?? "warning") ?? [],
        metrics: trajectory?.root_step.metrics_info ?? null,
        largest_artifacts: await topArtifactsByBytes(runDir, 5),
        trajectory: trajectory ? join(runDir, "trajectory.json") : null
    };
}
async function stitchRunTree(runDir, options) {
    const canonicalRoot = await realpath(resolve(runDir));
    const baseDir = resolve(canonicalRoot, "..", "..");
    const visited = new Set();
    const tree = await stitchRunNode(canonicalRoot, baseDir, visited, options.followChildren);
    return {
        schema_version: "openclaw.trajectory-stitch/v1",
        generated_at: new Date().toISOString(),
        root_run_dir: canonicalRoot,
        follow_children: options.followChildren,
        run_count: visited.size,
        tree
    };
}
async function runQuicktest(baseDir, options) {
    const recorder = await TrajectoryRecorder.start({
        baseDir,
        input: "OpenClaw trajectory quicktest",
        metadata: {
            source: "openclaw-trajectory-quicktest",
            "recording.mode": "quicktest"
        },
        sessionId: "quicktest_session",
        artifactStore: await artifactStoreOptions(options)
    });
    const sample = await readFile(new URL("../examples/sample-run.jsonl", import.meta.url), "utf8");
    await ingestRecordLines(recorder, sample.split("\n"), true, { stdout: () => undefined, stderr: () => undefined }, { ...options, progress: "false" });
    await recorder.finalize({ output: "quicktest completed", status: "ok" });
    await normalizeRun(recorder.runDir, { artifactMode: artifactModeOption(options), inferSpecs: options["infer-specs"] === "true" });
    await runPostProcessing(recorder.runDir, options);
    const validate = await validateRunDir(recorder.runDir);
    const quality = await qualityReport(recorder.runDir);
    const stitch = await stitchRunTree(recorder.runDir, { followChildren: true });
    return {
        schema_version: "openclaw.trajectory-quicktest/v1",
        status: validate.ok ? "ok" : "error",
        run_id: recorder.runId,
        run_dir: recorder.runDir,
        validate,
        quality,
        export: {
            otel: join(recorder.runDir, "spans.otlp.jsonl"),
            trajectory: join(recorder.runDir, "trajectory.json")
        },
        stitch
    };
}
async function resolveOpenClawBundleHookLog(bundleDir) {
    for (const file of ["hook-snapshot.jsonl", "plugin-message-hook.log", "events.jsonl"]) {
        const candidate = join(bundleDir, file);
        try {
            await access(candidate);
            return candidate;
        }
        catch {
            // keep looking
        }
    }
    throw new Error(`OpenClaw bundle hook log not found under ${bundleDir}. Expected hook-snapshot.jsonl, plugin-message-hook.log, or events.jsonl.`);
}
async function compareOpenClawBundle(runDir, bundleDir) {
    const toolkit = await readTrajectory(runDir);
    const official = await readOptionalJson(join(bundleDir, "trajectory.json"));
    const toolkitSteps = toolkit.agent_steps.flatMap((agentStep) => agentStep.steps);
    const officialSteps = countOpenClawBundleSteps(official);
    return {
        schema_version: "openclaw.trajectory-bundle-comparison/v1",
        generated_at: new Date().toISOString(),
        run_dir: runDir,
        bundle_dir: bundleDir,
        toolkit: {
            run_id: toolkit.run_id,
            step_count: toolkitSteps.length,
            model_step_count: toolkitSteps.filter((step) => step.type === "model").length,
            tool_step_count: toolkitSteps.filter((step) => step.type === "tool" || step.type === "shell" || step.type === "file" || step.type === "mcp").length
        },
        openclaw: {
            run_id: official?.run_id ?? null,
            step_count: officialSteps.stepCount,
            model_step_count: officialSteps.modelStepCount,
            tool_step_count: officialSteps.toolStepCount
        },
        deltas: {
            step_count: toolkitSteps.length - officialSteps.stepCount,
            model_step_count: toolkitSteps.filter((step) => step.type === "model").length - officialSteps.modelStepCount,
            tool_step_count: toolkitSteps.filter((step) => step.type === "tool" || step.type === "shell" || step.type === "file" || step.type === "mcp").length - officialSteps.toolStepCount
        }
    };
}
function countOpenClawBundleSteps(trajectory) {
    const agentSteps = Array.isArray(trajectory?.agent_steps) ? trajectory.agent_steps : [];
    const steps = agentSteps.flatMap((agentStep) => {
        const record = objectOrUndefined(agentStep);
        return Array.isArray(record?.steps) ? record.steps : [];
    });
    return {
        stepCount: steps.length,
        modelStepCount: steps.filter((step) => objectOrUndefined(step)?.type === "model").length,
        toolStepCount: steps.filter((step) => {
            const type = objectOrUndefined(step)?.type;
            return type === "tool" || type === "shell" || type === "file" || type === "mcp";
        }).length
    };
}
async function stitchRunNode(runDir, baseDir, visited, followChildren) {
    const trajectory = await readTrajectory(runDir);
    const run = await readOptionalJson(join(runDir, "run.json"));
    visited.add(await realpath(runDir).catch(() => resolve(runDir)));
    const node = {
        run_id: trajectory.run_id,
        run_dir: runDir,
        session_id: stringOrUndefined(run?.session_id) ?? stringOrUndefined(trajectory.root_step.metadata["openclaw.session_id"]) ?? sessionIdFromTrajectory(trajectory),
        agent_id: stringOrUndefined(run?.agent_id) ?? stringOrUndefined(trajectory.root_step.metadata["openclaw.agent_id"]) ?? null,
        trajectory,
        children: []
    };
    if (!followChildren)
        return node;
    const children = [];
    for (const child of trajectory.session_tree?.children ?? []) {
        const childRunDir = await findRunDirBySessionId(baseDir, child.session_id);
        if (!childRunDir) {
            children.push({ session_id: child.session_id, agent_id: child.agent_id ?? null, parent_step_id: child.parent_step_id, missing: true });
            continue;
        }
        const canonicalChild = await realpath(childRunDir).catch(() => resolve(childRunDir));
        if (visited.has(canonicalChild)) {
            children.push({ session_id: child.session_id, agent_id: child.agent_id ?? null, parent_step_id: child.parent_step_id, cycle: true, run_dir: canonicalChild });
            continue;
        }
        const childNode = await stitchRunNode(canonicalChild, baseDir, visited, true);
        children.push({ ...childNode, session_id: child.session_id, agent_id: child.agent_id ?? childNode.agent_id, parent_step_id: child.parent_step_id });
    }
    node.children = children;
    return node;
}
async function findRunDirBySessionId(baseDir, sessionId) {
    const runs = await listRuns(baseDir);
    for (const run of runs) {
        const runDir = String(run.run_dir);
        const runFile = await readOptionalJson(join(runDir, "run.json"));
        if (runFile?.session_id === sessionId || runFile?.metadata && objectOrUndefined(runFile.metadata)?.["openclaw.session_id"] === sessionId)
            return runDir;
        const trajectory = await readOptionalJson(join(runDir, "trajectory.json"));
        if (trajectory && sessionIdFromTrajectory(trajectory) === sessionId)
            return runDir;
        const steps = trajectory?.agent_steps.flatMap((agentStep) => agentStep.steps) ?? [];
        if (steps.some((step) => step.metadata["openclaw.session_id"] === sessionId || step.metadata["openclaw.event_session_id"] === sessionId))
            return runDir;
    }
    return null;
}
function sessionIdFromTrajectory(trajectory) {
    const root = stringOrUndefined(trajectory.root_step.metadata["openclaw.session_id"]);
    if (root)
        return root;
    for (const step of trajectory.agent_steps.flatMap((agentStep) => agentStep.steps)) {
        const value = stringOrUndefined(step.metadata["openclaw.session_id"] ?? step.metadata["openclaw.event_session_id"]);
        if (value)
            return value;
    }
    return null;
}
async function doctorBaseDir(baseDir, options) {
    const runs = await listRuns(baseDir);
    const issues = [];
    const staleAfterMs = parseDuration(options["stale-after"] ?? "1h");
    if (options["plugin"] === "true") {
        const home = resolve(options["home"] ?? homedir());
        const openclawHome = resolve(options["openclaw-home"] ?? home);
        const plugin = await pluginInstallStatus(home, openclawHome);
        if (!plugin.installed) {
            issues.push({ code: "plugin_manifest_missing", file: plugin.manifest_path });
        }
        else if (!plugin.enabled) {
            issues.push({ code: "plugin_disabled", file: plugin.manifest_path });
        }
        else if (!plugin.entry_exists) {
            issues.push({ code: "plugin_entry_missing", file: plugin.entry ?? null });
        }
        else if (plugin.openclaw_registered === false) {
            issues.push({ code: "plugin_not_registered_in_openclaw", file: plugin.openclaw_plugin_manifest ?? plugin.manifest_path });
        }
        if (plugin.installed === true && plugin.allowlist_allows === false) {
            issues.push({ code: "plugin_not_allowed_by_allowlist", file: plugin.openclaw_config_path });
        }
        if (plugin.installed === true && plugin.openclaw_registered === true && plugin.conversation_access_allowed === false) {
            issues.push({ code: "conversation_access_not_allowed", file: plugin.openclaw_config_path });
        }
        if (plugin.installed === true && plugin.runtime_version_mismatch === true) {
            issues.push({
                code: "runtime_version_mismatch",
                runtime_version: plugin.runtime_version,
                install_record_version: plugin.install_record_version,
                file: plugin.registry_path
            });
        }
    }
    for (const run of runs) {
        const runDir = String(run.run_dir);
        for (const file of ["run.json", "events.jsonl"]) {
            const path = join(runDir, file);
            try {
                await stat(path);
            }
            catch {
                issues.push({ run_id: run.run_id, code: "missing_file", file });
            }
        }
        if (run.status === "running" && run.last_event_at) {
            const ageMs = Date.now() - Date.parse(String(run.last_event_at));
            if (Number.isFinite(ageMs) && ageMs > staleAfterMs) {
                issues.push({
                    run_id: run.run_id,
                    code: (await hasActivePidFile(runDir)) ? "stale_running_run_active" : "stale_running_run",
                    last_event_at: run.last_event_at
                });
            }
        }
        if (run.status !== "running" && run.status !== "unreadable") {
            for (const file of ["trajectory.json", "normalization_report.json"]) {
                try {
                    await stat(join(runDir, file));
                }
                catch {
                    issues.push({ run_id: run.run_id, code: "missing_postprocess_file", file });
                }
            }
            for (const missing of await findMissingArtifacts(runDir)) {
                issues.push({ run_id: run.run_id, code: "missing_artifact", artifact: missing });
            }
        }
    }
    return {
        base_dir: baseDir,
        status: issues.some((issue) => issue.code === "missing_file" || issue.code === "missing_artifact") ? "error" : issues.length > 0 ? "warning" : "ok",
        run_count: runs.length,
        issue_count: issues.length,
        issues,
        policy: {
            conversation_access: conversationAccessDiagnostics(issues.some((issue) => issue.code === "conversation_access_not_allowed") ? false : null),
            behavior_intrusion: observerOnlyDiagnostics()
        }
    };
}
function conversationAccessDiagnostics(current) {
    return {
        current,
        intercepted_hooks: ["message_received", "before_model_resolve", "llm_input", "llm_output", "before_tool_call", "after_tool_call", "agent_end", "session_end"],
        sensitive_fields: ["systemPrompt", "historyMessages", "prompt", "assistantTexts", "tool params", "tool results", "message content"],
        sharing_recommendation: "Run redaction or summary-only export before sharing evidence packages."
    };
}
function observerOnlyDiagnostics() {
    return {
        observer_only: true,
        fetch_patch: false,
        curl_header_injection: false,
        llm_skip: false
    };
}
async function pluginInstallStatus(home, openclawHome = home) {
    const legacyManifestPath = join(home, ".openclaw", "plugins", "openclaw-trajectory", "plugin.json");
    const legacyManifest = await readOptionalJson(legacyManifestPath);
    const runtimeHome = openclawHome;
    const openclawConfigPath = join(runtimeHome, ".openclaw", "openclaw.json");
    const openclawConfig = await readOptionalJson(openclawConfigPath);
    const registryPath = join(runtimeHome, ".openclaw", "plugins", "installs.json");
    const registry = await readOpenClawPluginRegistry(runtimeHome, "openclaw-trajectory");
    const installRecord = registry.records.find((record) => typeof record.installPath === "string") ?? registry.records[0];
    const installVersionRecord = registry.records.find((record) => typeof record.raw.version === "string" && (!installRecord?.installPath || record.installPath === installRecord.installPath)) ??
        registry.records.find((record) => typeof record.raw.version === "string");
    const registrySource = installRecord?.source ?? installVersionRecord?.source ?? null;
    const entryRecord = openclawConfig?.plugins?.entries?.["openclaw-trajectory"];
    const allow = openclawConfig?.plugins?.allow;
    const allowlistAllows = Array.isArray(allow) && allow.length > 0 ? allow.includes("openclaw-trajectory") : true;
    const conversationAccessAllowed = entryRecord?.hooks?.allowConversationAccess === true;
    const extensionDir = typeof installRecord?.installPath === "string"
        ? installRecord.installPath
        : typeof legacyManifest?.openclaw_extension_dir === "string"
            ? legacyManifest.openclaw_extension_dir
            : join(runtimeHome, ".openclaw", "extensions", "openclaw-trajectory");
    const extensionManifestPath = typeof installRecord?.installPath === "string"
        ? join(installRecord.installPath, "openclaw.plugin.json")
        : typeof legacyManifest?.openclaw_plugin_manifest === "string"
            ? legacyManifest.openclaw_plugin_manifest
            : join(extensionDir, "openclaw.plugin.json");
    const extensionManifest = await readOptionalJson(extensionManifestPath);
    if (!legacyManifest && !extensionManifest) {
        return {
            installed: false,
            enabled: false,
            manifest_path: extensionManifestPath,
            legacy_manifest_path: legacyManifestPath,
            extension_dir: extensionDir,
            entry: null,
            entry_exists: false,
            openclaw_home: runtimeHome,
            openclaw_config_path: openclawConfigPath,
            registry_path: registryPath,
            registry_source: registrySource,
            openclaw_registered: false,
            allowlist_allows: allowlistAllows,
            conversation_access_allowed: conversationAccessAllowed,
            conversation_access_diagnostics: conversationAccessDiagnostics(conversationAccessAllowed),
            behavior_intrusion: observerOnlyDiagnostics(),
            supported_hooks: []
        };
    }
    const entry = extensionManifest ? join(extensionDir, "index.mjs") : typeof legacyManifest?.entry === "string" ? legacyManifest.entry : null;
    const entryExists = entry ? await access(entry).then(() => true, () => false) : false;
    const runtimeVersion = stringOrUndefined(extensionManifest?.version) ?? stringOrUndefined(legacyManifest?.version) ?? null;
    const installRecordVersion = stringOrUndefined(installVersionRecord?.raw.version ?? installRecord?.raw.version) ?? null;
    const supportedHooks = Array.isArray(legacyManifest?.supported_hooks)
        ? legacyManifest.supported_hooks
        : ["run", "session", "model", "tool", "message", "skill", "shell", "file", "mcp", "state", "subagent", "compaction", "diagnostic"];
    return {
        installed: true,
        enabled: entryRecord ? entryRecord.enabled === true : legacyManifest?.enabled !== false,
        auto_enable: legacyManifest?.auto_enable === true,
        mode: legacyManifest?.mode ?? "native",
        manifest_path: extensionManifest ? extensionManifestPath : legacyManifestPath,
        legacy_manifest_path: legacyManifestPath,
        openclaw_plugin_manifest: extensionManifestPath,
        openclaw_home: runtimeHome,
        openclaw_config_path: openclawConfigPath,
        registry_path: registryPath,
        registry_source: registrySource,
        extension_dir: extensionDir,
        entry,
        entry_exists: entryExists,
        openclaw_registered: Boolean(installRecord?.installPath),
        openclaw_install_path: installRecord?.installPath ?? null,
        runtime_version: runtimeVersion,
        install_record_version: installRecordVersion,
        runtime_version_mismatch: Boolean(runtimeVersion && installRecordVersion && runtimeVersion !== installRecordVersion),
        allowlist_allows: allowlistAllows,
        conversation_access_allowed: conversationAccessAllowed,
        conversation_access_diagnostics: conversationAccessDiagnostics(conversationAccessAllowed),
        behavior_intrusion: observerOnlyDiagnostics(),
        supported_hooks: supportedHooks
    };
}
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
async function topArtifactsByBytes(runDir, limit) {
    const indexed = await topArtifactsByIndex(runDir, limit);
    if (indexed.length > 0)
        return indexed;
    const metas = await findFiles(join(runDir, "artifacts"), (path) => path.endsWith(".meta.json"));
    const artifacts = [];
    for (const path of metas) {
        const meta = await readOptionalJson(path);
        if (meta)
            artifacts.push(meta);
    }
    return artifacts
        .sort((left, right) => Number(right.size_bytes ?? 0) - Number(left.size_bytes ?? 0))
        .slice(0, limit)
        .map((meta) => ({
        artifact_id: meta.artifact_id,
        uri: meta.uri,
        kind: meta.kind,
        size_bytes: meta.size_bytes,
        summary: meta.summary
    }));
}
async function topArtifactsByIndex(runDir, limit) {
    const raw = await readFile(join(runDir, "artifacts", "index.jsonl"), "utf8").catch(() => "");
    const artifacts = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
        try {
            return JSON.parse(line);
        }
        catch {
            return null;
        }
    })
        .filter((item) => item !== null);
    const byUri = new Map();
    for (const artifact of artifacts) {
        if (typeof artifact.uri === "string")
            byUri.set(artifact.uri, artifact);
    }
    return Array.from(byUri.values())
        .sort((left, right) => Number(right.size_bytes ?? 0) - Number(left.size_bytes ?? 0))
        .slice(0, limit)
        .map((meta) => ({
        artifact_id: meta.artifact_id,
        uri: meta.uri,
        kind: meta.kind,
        size_bytes: meta.size_bytes,
        summary: meta.summary
    }));
}
async function artifactBytes(runDir) {
    const indexed = await topArtifactsByIndex(runDir, Number.MAX_SAFE_INTEGER);
    if (indexed.length > 0) {
        return indexed.reduce((total, artifact) => total + Number(artifact.size_bytes ?? 0), 0);
    }
    const metas = await findFiles(join(runDir, "artifacts"), (path) => path.endsWith(".meta.json"));
    let total = 0;
    for (const path of metas) {
        const meta = await readOptionalJson(path);
        total += Number(meta?.size_bytes ?? 0);
    }
    return total;
}
async function dirBytes(path) {
    const info = await stat(path).catch(() => null);
    if (!info)
        return 0;
    if (!info.isDirectory())
        return info.size;
    let total = 0;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        total += await dirBytes(join(path, entry.name));
    }
    return total;
}
async function findFiles(root, predicate) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await findFiles(path, predicate)));
        }
        else if (predicate(path)) {
            files.push(path);
        }
    }
    return files;
}
async function validateRunDir(runDir) {
    const errors = [];
    await validateJsonFile(runDir, "run.json", "run.schema.json", errors);
    const eventsRaw = await readFile(join(runDir, "events.jsonl"), "utf8");
    const lines = eventsRaw.split("\n").filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined)
            continue;
        try {
            const event = JSON.parse(line);
            const eventErrors = await validateAgainstSchema("event.schema.json", event);
            if (eventErrors.length > 0) {
                errors.push({ file: "events.jsonl", line: index + 1, errors: eventErrors });
            }
        }
        catch (error) {
            errors.push({ file: "events.jsonl", line: index + 1, errors: [error instanceof Error ? error.message : String(error)] });
        }
    }
    await validateOptionalJsonFile(runDir, "trajectory.json", "trajectory.schema.json", errors);
    await validateOptionalJsonFile(runDir, "normalization_report.json", "normalization-report.schema.json", errors);
    await validateOptionalJsonFile(runDir, "config.snapshot.json", "config-snapshot.schema.json", errors);
    await validateOptionalJsonFile(runDir, "environment.snapshot.json", "environment-snapshot.schema.json", errors);
    await validateOptionalJsonFile(runDir, "run.pid.json", "run-pid.schema.json", errors);
    for (const metadataPath of await findFiles(join(runDir, "artifacts"), (path) => path.endsWith(".meta.json"))) {
        await validatePathWithSchema(runDir, metadataPath, "artifact.schema.json", errors);
    }
    const indexPath = join(runDir, "artifacts", "index.jsonl");
    const indexRaw = await readFile(indexPath, "utf8").catch(() => "");
    for (const [index, line] of indexRaw.split("\n").filter(Boolean).entries()) {
        try {
            const entry = JSON.parse(line);
            const entryErrors = await validateAgainstSchema("artifact-index.schema.json", entry);
            if (entryErrors.length > 0) {
                errors.push({ file: "artifacts/index.jsonl", line: index + 1, errors: entryErrors });
            }
        }
        catch (error) {
            errors.push({ file: "artifacts/index.jsonl", line: index + 1, errors: [error instanceof Error ? error.message : String(error)] });
        }
    }
    for (const missing of await findMissingArtifacts(runDir)) {
        errors.push({ file: "trajectory.json", code: "missing_artifact", artifact: missing });
    }
    return { ok: errors.length === 0, errors };
}
async function hasActivePidFile(runDir) {
    const pidFile = await readOptionalJson(join(runDir, "run.pid.json"));
    if (!pidFile)
        return false;
    if (pidFile.hostname !== undefined && pidFile.hostname !== hostname()) {
        return false;
    }
    const pid = typeof pidFile.pid === "number" ? pidFile.pid : Number(pidFile.pid);
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function validateJsonFile(runDir, file, schemaFile, errors) {
    const path = join(runDir, file);
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        const schemaErrors = await validateAgainstSchema(schemaFile, value);
        if (schemaErrors.length > 0)
            errors.push({ file, errors: schemaErrors });
    }
    catch (error) {
        errors.push({ file, errors: [error instanceof Error ? error.message : String(error)] });
    }
}
async function validateOptionalJsonFile(runDir, file, schemaFile, errors) {
    try {
        await access(join(runDir, file));
    }
    catch {
        return;
    }
    await validateJsonFile(runDir, file, schemaFile, errors);
}
async function validatePathWithSchema(runDir, path, schemaFile, errors) {
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        const schemaErrors = await validateAgainstSchema(schemaFile, value);
        if (schemaErrors.length > 0)
            errors.push({ file: relative(runDir, path), errors: schemaErrors });
    }
    catch (error) {
        errors.push({ file: relative(runDir, path), errors: [error instanceof Error ? error.message : String(error)] });
    }
}
const schemaCache = new Map();
async function validateAgainstSchema(schemaFile, value) {
    const validator = await schemaValidator(schemaFile);
    if (validator(value))
        return [];
    return formatSchemaErrors(validator.errors ?? []);
}
function schemaValidator(schemaFile) {
    const existing = schemaCache.get(schemaFile);
    if (existing)
        return existing;
    const next = readFile(new URL(`../schemas/${schemaFile}`, import.meta.url), "utf8").then((raw) => {
        const ajv = new AjvClass({ allErrors: true, strict: false, validateFormats: false });
        return ajv.compile(JSON.parse(raw));
    });
    schemaCache.set(schemaFile, next);
    return next;
}
function formatSchemaErrors(errors) {
    return errors.map((error) => {
        const path = error.instancePath || "/";
        const allowed = "allowedValues" in error.params ? ` allowed=${JSON.stringify(error.params.allowedValues)}` : "";
        return `${path} [${error.keyword}] ${error.message ?? error.keyword}${allowed}`;
    });
}
async function readOptionalJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return null;
    }
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
    runCli(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
//# sourceMappingURL=cli.js.map