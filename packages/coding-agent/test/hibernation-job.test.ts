import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	launchJob,
	observeJob,
	probeUnit,
	readJobResult,
	stopUnit,
	systemdUserAvailable,
	verifyArtifacts,
} from "../src/hibernation/job";
import { hibernationPaths } from "../src/hibernation/store";
import { HIBERNATION_RECORD_VERSION, type HibernationRecord } from "../src/hibernation/types";
import { currentProcessIdentity } from "../src/hibernation/store";

const systemd = systemdUserAvailable();
const tempDirs: string[] = [];

function tempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hiber-job-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function recordFor(root: string, job: HibernationRecord["job"]): HibernationRecord {
	const now = new Date().toISOString();
	const owner = currentProcessIdentity();
	return {
		version: HIBERNATION_RECORD_VERSION,
		registrationId: "job-test",
		session: { id: "s", file: path.join(root, "session.jsonl"), headerSha256: "0".repeat(64), cwd: root },
		job,
		owner,
		host: { hostname: os.hostname(), ...(owner.bootId !== undefined && { bootId: owner.bootId }), ompVersion: "test" },
		watcher: { socket: "", mode: "local-only", registrationId: "job-test", coordinatorAcked: false },
		wake: {
			condition: { onExit: true, requireArtifacts: true, maxWaitMs: 60_000 },
			policy: "manual",
			estimatedWaitMs: 1000,
			intent: { objective: "test" },
			events: [],
		},
		state: "PREPARING",
		generation: 0,
		createdAt: now,
		updatedAt: now,
		history: [],
		diagnostics: [],
	};
}

async function awaitObservation(record: HibernationRecord, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const observation = observeJob(record);
		if (observation.kind !== "running") return observation;
		await Bun.sleep(250);
	}
	throw new Error("job did not settle");
}

describe.skipIf(!systemd.available)("systemd hibernation jobs", () => {
	it("runs independently, publishes a result contract, and verifies artifacts", async () => {
		const root = tempRoot();
		const paths = hibernationPaths(path.join(root, "hibernation"));
		const cwd = path.join(root, "work");
		fs.mkdirSync(cwd, { recursive: true });
		const launched = launchJob({
			jobId: "ok-job",
			command: "printf 'result' > out.txt",
			cwd,
			timeoutMs: 30_000,
			requiredArtifacts: ["out.txt"],
			paths,
		});
		expect(probeUnit(launched.job.unit).loadState).toBe("loaded");
		const record = recordFor(root, launched.job);
		const observation = await awaitObservation(record);
		expect(observation.kind).toBe("completed");
		if (observation.kind !== "completed") throw new Error("expected completion");
		expect(observation.artifacts.ok).toBe(true);
		const result = readJobResult(launched.job.resultDir);
		expect(result?.exitCode).toBe(0);
		expect(result?.commandSha256).toBe(launched.job.commandSha256);
		expect(verifyArtifacts(launched.job, result!).artifacts[0]?.size).toBe(6);
	});

	it("reports a nonzero exit as failure, not success", async () => {
		const root = tempRoot();
		const paths = hibernationPaths(path.join(root, "hibernation"));
		const cwd = path.join(root, "work");
		fs.mkdirSync(cwd, { recursive: true });
		const launched = launchJob({
			jobId: "fail-job",
			command: "echo boom >&2; exit 3",
			cwd,
			timeoutMs: 30_000,
			requiredArtifacts: [],
			paths,
		});
		const observation = await awaitObservation(recordFor(root, launched.job));
		expect(observation.kind).toBe("failed");
		if (observation.kind !== "failed") throw new Error("expected failure");
		expect(observation.result?.exitCode).toBe(3);
	});

	it("does not treat a missing required artifact as completion", async () => {
		const root = tempRoot();
		const paths = hibernationPaths(path.join(root, "hibernation"));
		const cwd = path.join(root, "work");
		fs.mkdirSync(cwd, { recursive: true });
		const launched = launchJob({
			jobId: "missing-artifact",
			command: "true",
			cwd,
			timeoutMs: 30_000,
			requiredArtifacts: ["never.txt"],
			paths,
		});
		const observation = await awaitObservation(recordFor(root, launched.job));
		expect(observation.kind).toBe("failed");
	});

	it("can stop a running unit", async () => {
		const root = tempRoot();
		const paths = hibernationPaths(path.join(root, "hibernation"));
		const cwd = path.join(root, "work");
		fs.mkdirSync(cwd, { recursive: true });
		const launched = launchJob({
			jobId: "stop-job",
			command: "sleep 30",
			cwd,
			timeoutMs: 60_000,
			requiredArtifacts: [],
			paths,
		});
		const record = recordFor(root, launched.job);
		expect(observeJob(record).kind).toBe("running");
		expect(stopUnit(launched.job.unit).exitCode).toBe(0);
		const observation = await awaitObservation(record, 15_000);
		expect(observation.kind).not.toBe("running");
	});
});
