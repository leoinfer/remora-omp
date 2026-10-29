import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
	claimWakeEvent,
	consumeWakeEvent,
	currentProcessIdentity,
	hibernationPaths,
	inspectRecovery,
	readRecordFile,
	readSessionHeaderIdentity,
	recordPath,
	saveRecord,
	sessionKey,
	transition,
	probeProcessIdentity,
} from "../src/hibernation/store";
import {
	canTransition,
	HIBERNATION_RECORD_VERSION,
	isHibernatingState,
	parseHibernationRecord,
	type HibernationRecord,
} from "../src/hibernation/types";

const tempDirs: string[] = [];

function tempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hiber-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeSession(dir: string, id = "session-abc"): { file: string; headerSha256: string } {
	const file = path.join(dir, `${id}.jsonl`);
	const header = JSON.stringify({ type: "session", id, cwd: dir, version: 3 });
	fs.writeFileSync(file, `${header}\n`, { mode: 0o600 });
	return { file, headerSha256: createHash("sha256").update(header).digest("hex") };
}

function makeRecord(session: { file: string; headerSha256: string }, dir: string): HibernationRecord {
	const now = new Date().toISOString();
	const owner = currentProcessIdentity();
	return {
		version: HIBERNATION_RECORD_VERSION,
		registrationId: "hib-test-1",
		session: {
			id: "session-abc",
			file: session.file,
			headerSha256: session.headerSha256,
			cwd: dir,
		},
		job: {
			id: "job-1",
			runId: "job-1-run",
			command: "sleep 10",
			commandSha256: createHash("sha256").update("sleep 10").digest("hex"),
			cwd: dir,
			unit: "omp-hiber-job-1-run.service",
			resultDir: path.join(dir, "results"),
			startedAt: now,
			timeoutMs: 60_000,
			requiredArtifacts: [],
			successExitCodes: [0],
			launch: "systemd-user-transient",
		},
		owner,
		host: {
			hostname: os.hostname(),
			...(owner.bootId !== undefined && { bootId: owner.bootId }),
			ompVersion: "test",
		},
		watcher: {
			socket: "/tmp/none.sock",
			mode: "required",
			registrationId: "hib-test-1",
			coordinatorAcked: true,
		},
		wake: {
			condition: { onExit: true, requireArtifacts: false, maxWaitMs: 60_000 },
			policy: "auto",
			estimatedWaitMs: 60_000,
			intent: { objective: "test the store" },
			events: [],
		},
		state: "PREPARING",
		generation: 0,
		createdAt: now,
		updatedAt: now,
		history: [{ from: null, to: "PREPARING", at: now }],
		diagnostics: [],
	};
}

describe("hibernation lifecycle", () => {
	it("accepts only the documented transitions", () => {
		expect(canTransition("PREPARING", "HIBERNATED")).toBe(true);
		expect(canTransition("HIBERNATED", "WAKE_PENDING")).toBe(true);
		expect(canTransition("WAKE_PENDING", "RESUMING")).toBe(true);
		expect(canTransition("RESUMING", "ACTIVE")).toBe(true);
		expect(canTransition("ACTIVE", "HIBERNATED")).toBe(false);
		expect(canTransition("HIBERNATED", "RESUMING")).toBe(false);
		expect(canTransition("CANCELLED", "RESUMING")).toBe(false);
		expect(isHibernatingState("WAKE_PENDING")).toBe(true);
		expect(isHibernatingState("ACTIVE")).toBe(false);
	});

	it("refuses an illegal transition instead of writing it", () => {
		const dir = tempRoot();
		const session = makeSession(dir);
		const record = makeRecord(session, dir);
		expect(() => transition(record, "RESUMING")).toThrow(/illegal hibernation transition/);
	});
});

describe("durable record storage", () => {
	it("round-trips a record and journals transitions with fsync'd lines", () => {
		const dir = tempRoot();
		const paths = hibernationPaths(dir);
		const session = makeSession(dir);
		let record = makeRecord(session, dir);
		const file = recordPath(record.session.id, paths);
		saveRecord(file, record, paths);
		record = transition(readRecordFile(file), "HIBERNATED", "watcher ack");
		saveRecord(file, record, paths, 1);
		const loaded = readRecordFile(file);
		expect(loaded.state).toBe("HIBERNATED");
		expect(loaded.history).toHaveLength(2);
		const journal = fs.readFileSync(paths.journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(journal.some(entry => entry.event === "state_transition" && entry.state === "HIBERNATED")).toBe(true);
		expect(loaded.registrationId).toBe("hib-test-1");
	});

	it("parses a record with an unknown field shape defensively", () => {
		const dir = tempRoot();
		const session = makeSession(dir);
		const record = makeRecord(session, dir);
		const parsed = parseHibernationRecord(JSON.parse(JSON.stringify(record)));
		expect(parsed.session.id).toBe("session-abc");
		expect(parsed.wake.events).toEqual([]);
		expect(() => parseHibernationRecord({ ...record, state: "NOT_A_STATE" })).toThrow(/unknown state/);
	});

	it("builds a stable filesystem key for unsafe session ids", () => {
		expect(sessionKey("plain-id")).toBe("plain-id");
		expect(sessionKey("../escape")).toMatch(/^h-[0-9a-f]{32}$/);
		expect(sessionKey("../escape")).toBe(sessionKey("../escape"));
	});
});

describe("session identity", () => {
	it("skips a title slot and hashes the session header", () => {
		const dir = tempRoot();
		const file = path.join(dir, "session.jsonl");
		const header = JSON.stringify({ type: "session", id: "id-1", cwd: dir });
		fs.writeFileSync(file, `${JSON.stringify({ type: "title", title: "hello" })}\n${header}\n`);
		const identity = readSessionHeaderIdentity(file);
		expect(identity.id).toBe("id-1");
		expect(identity.cwd).toBe(dir);
		expect(identity.headerSha256).toBe(createHash("sha256").update(header).digest("hex"));
	});
});

describe("wake event claims", () => {
	function prepared(): { dir: string; paths: ReturnType<typeof hibernationPaths>; record: HibernationRecord } {
		const dir = tempRoot();
		const paths = hibernationPaths(dir);
		const session = makeSession(dir);
		let record = transition(makeRecord(session, dir), "HIBERNATED", "ack");
		record = {
			...record,
			wake: {
				...record.wake,
				events: [
					{
						id: "wake-1",
						kind: "completed",
						generation: 1,
						createdAt: new Date().toISOString(),
					},
				],
			},
		};
		record = transition(record, "WAKE_PENDING", "job completed");
		saveRecord(recordPath(record.session.id, paths), record, paths, 1);
		return { dir, paths, record };
	}

	it("claims exactly once and refuses a duplicate", () => {
		const { paths, record } = prepared();
		const first = claimWakeEvent(record.session.id, "wake-1", currentProcessIdentity(), {}, paths);
		expect(first.status).toBe("claimed");
		if (first.status !== "claimed") throw new Error("expected claimed");
		expect(first.record.state).toBe("RESUMING");
		const duplicate = claimWakeEvent(
			record.session.id,
			"wake-1",
			{ pid: 1, hostname: os.hostname(), bootId: currentProcessIdentity().bootId },
			{},
			paths,
		);
		// The second claim sees the live holder and refuses to start a competing agent.
		expect(duplicate.status).toBe("busy");
		const consumed = consumeWakeEvent(
			record.session.id,
			"wake-1",
			{ outcome: "resumed", sessionSizeBefore: 10, sessionSizeAfter: 20 },
			paths,
		);
		expect(consumed.state).toBe("ACTIVE");
		expect(consumed.wake.events[0]?.consumedAt).toBeDefined();
		const after = claimWakeEvent(record.session.id, "wake-1", currentProcessIdentity(), {}, paths);
		expect(after.status).toBe("already_consumed");
	});

	it("reclaims a claim whose holder is dead only when allowed", () => {
		const { paths, record } = prepared();
		const deadHolder = {
			pid: 999_999,
			startTicks: 1,
			bootId: currentProcessIdentity().bootId,
			hostname: os.hostname(),
		};
		const claimed = claimWakeEvent(record.session.id, "wake-1", deadHolder, {}, paths);
		expect(claimed.status).toBe("claimed");
		const blocked = claimWakeEvent(record.session.id, "wake-1", currentProcessIdentity(), {}, paths);
		expect(blocked.status).toBe("busy");
		const reclaimed = claimWakeEvent(
			record.session.id,
			"wake-1",
			currentProcessIdentity(),
			{ allowReclaim: true },
			paths,
		);
		expect(reclaimed.status).toBe("claimed");
	});

	it("detects a reused pid by start time", () => {
		const alive = currentProcessIdentity();
		expect(probeProcessIdentity(alive).alive).toBe(true);
		expect(probeProcessIdentity({ ...alive, startTicks: (alive.startTicks ?? 0) + 1 }).alive).toBe(false);
	});
});

describe("recovery inspection", () => {
	it("marks a resume claim with no live holder for recovery", () => {
		const dir = tempRoot();
		const paths = hibernationPaths(dir);
		const session = makeSession(dir);
		let record = makeRecord(session, dir);
		record = transition(record, "HIBERNATED", "ack");
		record = transition(record, "WAKE_PENDING", "event");
		record = {
			...record,
			wake: {
				...record.wake,
				events: [
					{
						id: "wake-dead",
						kind: "completed",
						generation: 1,
						createdAt: new Date().toISOString(),
						claimedAt: new Date().toISOString(),
						claimedBy: { pid: 999_999, startTicks: 1, bootId: currentProcessIdentity().bootId },
					},
				],
			},
		};
		record = transition(record, "RESUMING", "claimed");
		saveRecord(recordPath(record.session.id, paths), record, paths, 1);
		const findings = inspectRecovery(paths);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.action).toBe("mark-recovery");
	});
});
