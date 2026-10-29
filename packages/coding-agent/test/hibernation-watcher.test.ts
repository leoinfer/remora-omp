import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startFakeWatcher, type FakeWatcher } from "./hibernation-watcher-server";
import { WatcherClient, WatcherError } from "../src/hibernation/watcher";
import {
	currentProcessIdentity,
	hibernationPaths,
	readRecordFile,
	recordPath,
	saveRecord,
	transition,
} from "../src/hibernation/store";
import { HIBERNATION_RECORD_VERSION, type HibernationRecord } from "../src/hibernation/types";

const cleanups: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

function tempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hiber-watcher-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRecord(root: string): HibernationRecord {
	const now = new Date().toISOString();
	const owner = currentProcessIdentity();
	const sessionFile = path.join(root, "session.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "sess-w", cwd: root })}\n`);
	return {
		version: HIBERNATION_RECORD_VERSION,
		registrationId: "hib-watcher-1",
		session: { id: "sess-w", file: sessionFile, headerSha256: "a".repeat(64), cwd: root },
		job: {
			id: "job-w",
			runId: "job-w-run",
			cwd: root,
			unit: "omp-hiber-job-w.service",
			resultDir: path.join(root, "results"),
			startedAt: now,
			timeoutMs: 60_000,
			requiredArtifacts: [],
			successExitCodes: [0],
			launch: "systemd-user-transient",
		},
		owner,
		host: { hostname: os.hostname(), ompVersion: "test" },
		watcher: {
			socket: "",
			mode: "required",
			registrationId: "hib-watcher-1",
			coordinatorAcked: true,
		},
		wake: {
			condition: { onExit: true, requireArtifacts: false, maxWaitMs: 60_000 },
			policy: "manual",
			estimatedWaitMs: 60_000,
			intent: { objective: "test the watcher client" },
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

async function start(token?: string): Promise<FakeWatcher> {
	const dir = tempRoot();
	const watcher = await startFakeWatcher({ dir, ...(token !== undefined && { token }) });
	cleanups.push(() => watcher.close());
	return watcher;
}

describe("watcher client", () => {
	it("registers idempotently, reports status, and acknowledges a wake", async () => {
		const watcher = await start();
		const client = new WatcherClient({ socket: watcher.socket, tokenFile: watcher.tokenFile });
		const record = makeRecord(tempRoot());
		const first = await client.register(record);
		expect(first.accepted).toBe(true);
		expect(first.coordinator.acked).toBe(true);
		const second = await client.register(record);
		expect(second.registrationId).toBe(first.registrationId);
		const event = watcher.addEvent(first.registrationId, "completed");
		const status = await client.status(first.registrationId);
		expect(status.wake.pendingEvents.map(pending => pending.id)).toEqual([event.id]);
		await client.ack(first.registrationId, event.id, "resumed", "test");
		const registration = watcher.registrations.get(first.registrationId);
		expect(registration?.acks.at(-1)?.outcome).toBe("resumed");
		expect(registration?.state).toBe("ACTIVE");
	});

	it("reports a coordinator-degraded acknowledgement without pretending it was durable", async () => {
		const watcher = await startFakeWatcher({ dir: tempRoot(), coordinatorAcked: false });
		cleanups.push(() => watcher.close());
		const client = new WatcherClient({ socket: watcher.socket, tokenFile: watcher.tokenFile });
		const ack = await client.register(makeRecord(tempRoot()));
		expect(ack.accepted).toBe(true);
		expect(ack.coordinator.acked).toBe(false);
		expect(ack.coordinator.detail).toContain("coordinator unreachable");
	});

	it("refuses a request with the wrong capability token", async () => {
		const watcher = await start("right-token");
		const wrong = path.join(tempRoot(), "wrong.token");
		fs.writeFileSync(wrong, "wrong-token\n");
		const client = new WatcherClient({ socket: watcher.socket, tokenFile: wrong });
		await expect(client.status("missing")).rejects.toBeInstanceOf(WatcherError);
	});

	it("cancels through the watcher", async () => {
		const watcher = await start();
		const client = new WatcherClient({ socket: watcher.socket, tokenFile: watcher.tokenFile });
		const record = makeRecord(tempRoot());
		const ack = await client.register(record);
		await client.cancel(ack.registrationId, { stopJob: true, reason: "test cancel" });
		expect(watcher.registrations.get(ack.registrationId)?.cancelled).toEqual({
			stopJob: true,
			reason: "test cancel",
		});
	});
});

describe("record persistence used by the client", () => {
	it("writes and reads the exact record the watcher received", () => {
		const root = tempRoot();
		const paths = hibernationPaths(path.join(root, "hibernation"));
		const record = makeRecord(root);
		const file = recordPath(record.session.id, paths);
		saveRecord(file, record, paths);
		const hibernated = transition(readRecordFile(file), "HIBERNATED", "ack");
		saveRecord(file, hibernated, paths, 0);
		expect(readRecordFile(file).state).toBe("HIBERNATED");
	});
});
