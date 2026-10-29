import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
	completeWake,
	prepareWake,
	WakeAlreadyConsumedError,
} from "../src/hibernation/service";
import {
	appendWakeEvent,
	currentProcessIdentity,
	hibernationPaths,
	readRecordFile,
	recordPath,
	saveRecord,
	transition,
} from "../src/hibernation/store";
import { HIBERNATION_RECORD_VERSION, type HibernationRecord } from "../src/hibernation/types";

const tempDirs: string[] = [];

function tempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hiber-wake-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(withEvent = true): {
	root: string;
	paths: ReturnType<typeof hibernationPaths>;
	record: HibernationRecord;
} {
	const root = tempRoot();
	const paths = hibernationPaths(path.join(root, "hibernation"));
	const sessionFile = path.join(root, "session.jsonl");
	const header = JSON.stringify({ type: "session", id: "sess-wake", cwd: root });
	const user = JSON.stringify({
		type: "message",
		timestamp: new Date(Date.now() - 60_000).toISOString(),
		message: { role: "user", content: [{ type: "text", text: "launch the experiment" }] },
	});
	fs.writeFileSync(sessionFile, `${header}\n${user}\n`);
	const now = new Date().toISOString();
	const owner = { ...currentProcessIdentity(), pid: 999_999, startTicks: 1 };
	const record: HibernationRecord = {
		version: HIBERNATION_RECORD_VERSION,
		registrationId: "hib-wake-1",
		session: {
			id: "sess-wake",
			file: sessionFile,
			headerSha256: createHash("sha256").update(header).digest("hex"),
			cwd: root,
		},
		job: {
			id: "job-wake",
			runId: "job-wake-run",
			cwd: root,
			unit: "omp-hiber-job-wake-run.service",
			resultDir: path.join(root, "results"),
			startedAt: now,
			timeoutMs: 60_000,
			requiredArtifacts: [],
			successExitCodes: [0],
			launch: "systemd-user-transient",
		},
		owner,
		host: { hostname: os.hostname(), ompVersion: "test" },
		watcher: { socket: "", mode: "local-only", registrationId: "hib-wake-1", coordinatorAcked: false },
		wake: {
			condition: { onExit: true, requireArtifacts: false, maxWaitMs: 60_000 },
			policy: "manual",
			estimatedWaitMs: 60_000,
			intent: { objective: "finish the experiment", hypothesis: "the job proves it" },
			events: [],
		},
		state: "HIBERNATED",
		generation: 0,
		createdAt: now,
		updatedAt: now,
		history: [{ from: null, to: "PREPARING", at: now }],
		diagnostics: [],
	};
	const file = recordPath(record.session.id, paths);
	saveRecord(file, record, paths);
	if (withEvent) {
		const event = {
			id: "wake-test-1",
			kind: "completed" as const,
			generation: 1,
			createdAt: now,
		};
		appendWakeEvent(record.session.id, event, paths);
	}
	return { root, paths, record: readRecordFile(file) };
}

describe("wake transaction", () => {
	it("claims one pending event and builds a structured handoff", () => {
		const { root, paths } = fixture();
		const plan = prepareWake({ sessionRef: path.join(root, "session.jsonl"), paths });
		expect(plan.event.id).toBe("wake-test-1");
		expect(plan.prompt).toContain("omp-hibernation-wake");
		expect(plan.prompt).toContain("finish the experiment");
		expect(plan.record.state).toBe("RESUMING");
	});

	it("refuses a second resume while the first claim is live", () => {
		const { root, paths } = fixture();
		prepareWake({ sessionRef: path.join(root, "session.jsonl"), paths });
		expect(() => prepareWake({ sessionRef: path.join(root, "session.jsonl"), paths })).toThrow(/already claimed/);
	});

	it("consumes the event exactly once and reports a duplicate as already consumed", () => {
		const { root, paths } = fixture();
		const plan = prepareWake({ sessionRef: path.join(root, "session.jsonl"), paths });
		const consumed = completeWake(plan, { ok: true, sessionSizeAfter: 999 }, paths);
		expect(consumed.state).toBe("ACTIVE");
		expect(consumed.wake.events[0]?.consumedAt).toBeDefined();
		expect(() => prepareWake({ sessionRef: path.join(root, "session.jsonl"), paths })).toThrow(
			WakeAlreadyConsumedError,
		);
	});

	it("refuses to resume a different conversation at the recorded path", () => {
		const { root, paths, record } = fixture();
		const replacement = path.join(root, "session.jsonl");
		fs.writeFileSync(
			replacement,
			`${JSON.stringify({ type: "session", id: "other-session", cwd: root })}\n`,
		);
		expect(() => prepareWake({ sessionRef: record.session.id, paths })).toThrow(/identity changed/);
	});

	it("creates an explicit manual wake when none is pending", () => {
		const { root, paths } = fixture(false);
		const record = readRecordFile(recordPath("sess-wake", paths));
		const manual = prepareWake({
			sessionRef: record.session.file,
			paths,
			force: true,
			manualReason: "operator requested",
		});
		expect(manual.event.kind).toBe("manual");
	});
});
