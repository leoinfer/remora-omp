/**
 * Crash-safe storage for hibernation records.
 *
 * Layout (under the active agent directory):
 *
 *   hibernation/
 *     records/<session-key>.json   current record per session
 *     journal.jsonl                append-only transition log, fsynced per line
 *     jobs/<runId>/                runner script, stdout/stderr, result.json
 *     logs/                        watcher/wake logs
 *     watcher.token                local socket capability token (0600)
 *
 * Writes use a private sibling temp file, fsync, rename, then fsync the parent
 * directory. Record mutations also take a process-owned OS lease, so two OMP
 * processes cannot interleave read-modify-write on the same record.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import {
	type FileLockHandle,
	tryAcquireFileLock,
	withFileLockSync,
} from "@oh-my-pi/pi-utils/file-lock";
import {
	canTransition,
	type HibernationRecord,
	type HibernationState,
	isHibernatingState,
	parseHibernationRecord,
	type ProcessIdentity,
	type WakeEvent,
} from "./types";

const RECORD_MUTEX_OPTIONS = { retries: 40, retryDelayMs: 25 } as const;

export interface HibernationPaths {
	root: string;
	records: string;
	journal: string;
	jobs: string;
	logs: string;
	token: string;
}

export function hibernationPaths(root?: string): HibernationPaths {
	const base = root ?? path.join(getAgentDir(), "hibernation");
	return {
		root: base,
		records: path.join(base, "records"),
		journal: path.join(base, "journal.jsonl"),
		jobs: path.join(base, "jobs"),
		logs: path.join(base, "logs"),
		token: path.join(base, "watcher.token"),
	};
}

export function ensureHibernationDirs(paths = hibernationPaths()): HibernationPaths {
	fs.mkdirSync(paths.records, { recursive: true, mode: 0o700 });
	fs.mkdirSync(paths.jobs, { recursive: true, mode: 0o700 });
	fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
	return paths;
}

/** A stable file key for a session id, safe on every filesystem. */
export function sessionKey(sessionId: string): string {
	if (/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return sessionId;
	return `h-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

export function recordPath(sessionId: string, paths = hibernationPaths()): string {
	return path.join(paths.records, `${sessionKey(sessionId)}.json`);
}

function fsyncDirectory(directory: string): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(directory, "r");
		fs.fsyncSync(fd);
	} catch {
		// Directory fsync is not supported everywhere; the rename is still atomic.
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
	}
}

export function readRecordFile(filePath: string): HibernationRecord {
	return parseHibernationRecord(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

export function tryReadRecord(filePath: string): HibernationRecord | undefined {
	try {
		return readRecordFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function writeRecordFile(filePath: string, record: HibernationRecord): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const content = `${JSON.stringify(record, null, "\t")}\n`;
	// writeFileAtomically is synchronous internally; use the sync sibling to keep
	// the caller's read-modify-write sequence atomic.
	writeSignedFile(filePath, content);
}

function writeSignedFile(filePath: string, content: string): void {
	const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		fs.writeFileSync(fd, content, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(tempPath, filePath);
		fsyncDirectory(path.dirname(filePath));
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
		fs.rmSync(tempPath, { force: true });
		throw error;
	}
}

export interface JournalEntry {
	at: string;
	event: string;
	registrationId?: string;
	sessionId?: string;
	state?: HibernationState;
	previous?: HibernationState;
	eventId?: string;
	generation?: number;
	detail?: string;
}

export function appendJournal(entry: JournalEntry, paths = hibernationPaths()): void {
	ensureHibernationDirs(paths);
	const line = `${JSON.stringify(entry)}\n`;
	const fd = fs.openSync(paths.journal, "a", 0o600);
	try {
		fs.writeFileSync(fd, line, "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

export function listRecords(paths = hibernationPaths()): HibernationRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(paths.records);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: HibernationRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			records.push(readRecordFile(path.join(paths.records, name)));
		} catch {
			// A malformed record must not hide the rest of the list; `recover`
			// reports it separately.
		}
	}
	return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Compute the current process identity (PID + start time + boot id). */
export function currentProcessIdentity(): ProcessIdentity {
	const bootId = readBootId();
	return {
		pid: process.pid,
		...(readProcessStartTicks(process.pid) !== undefined && {
			startTicks: readProcessStartTicks(process.pid),
		}),
		...(bootId !== undefined && { bootId }),
		hostname: os.hostname(),
		observedAt: new Date().toISOString(),
	};
}

export function readBootId(): string | undefined {
	try {
		return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Linux `/proc/<pid>/stat` field 22, robust to spaces and parentheses in comm. */
export function readProcessStartTicks(pid: number): number | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const fields = stat.slice(close + 2).split(" ");
		// After the comm, field 3 is state; starttime is field 22, index 19 here.
		const value = Number.parseInt(fields[19] ?? "", 10);
		return Number.isSafeInteger(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export interface LivenessProbe {
	alive: boolean;
	reason: string;
}

/**
 * Whether a recorded process identity still names the same live process.
 * A PID alone is never trusted: the boot id and start time must agree.
 */
export function probeProcessIdentity(identity: ProcessIdentity): LivenessProbe {
	if (identity.bootId && readBootId() && identity.bootId !== readBootId()) {
		return { alive: false, reason: "kernel boot id changed" };
	}
	if (identity.hostname && identity.hostname !== os.hostname()) {
		return { alive: false, reason: `recorded on ${identity.hostname}` };
	}
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return { alive: false, reason: "process is gone" };
		if (code !== "EPERM") return { alive: false, reason: `liveness probe failed: ${code ?? "unknown"}` };
	}
	if (identity.startTicks !== undefined) {
		const current = readProcessStartTicks(identity.pid);
		if (current === undefined) return { alive: false, reason: "process is gone" };
		if (current !== identity.startTicks) {
			return { alive: false, reason: "pid was reused by another process" };
		}
	}
	return { alive: true, reason: "process is alive" };
}

export function sessionFileSize(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

export interface SessionHeaderIdentity {
	id: string;
	cwd: string;
	headerLine: string;
	headerSha256: string;
}

/**
 * Read the durable session identity from a session JSONL. OMP may write a
 * title slot before the header; scan a bounded prefix for the `session` entry.
 */
export function readSessionHeaderIdentity(file: string): SessionHeaderIdentity {
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(1024 * 1024);
		const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.toString("utf8", 0, read);
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (typeof parsed !== "object" || parsed === null) continue;
				if (!("type" in parsed) || parsed.type !== "session") continue;
				if (!("id" in parsed) || typeof parsed.id !== "string") {
					throw new Error(`session header in ${file} has no string id`);
				}
				return {
					id: parsed.id,
					cwd: "cwd" in parsed && typeof parsed.cwd === "string" ? parsed.cwd : path.dirname(file),
					headerLine: line,
					headerSha256: createHash("sha256").update(line).digest("hex"),
				};
			} catch (error) {
				if (error instanceof SyntaxError) continue;
				throw error;
			}
		}
	} finally {
		fs.closeSync(fd);
	}
	throw new Error(`no session header found in ${file}`);
}

/** Resolve a record by session id or session file path. */
export function findRecord(sessionRef: string, paths = hibernationPaths()): HibernationRecord | undefined {
	if (sessionRef.endsWith(".jsonl") || sessionRef.includes("/")) {
		try {
			const identity = readSessionHeaderIdentity(sessionRef);
			return tryReadRecord(recordPath(identity.id, paths));
		} catch {
			// Fall through to scanning by stored path.
		}
	}
	const direct = tryReadRecord(recordPath(sessionRef, paths));
	if (direct) return direct;
	const normalized = path.resolve(sessionRef);
	for (const record of listRecords(paths)) {
		if (record.session.id === sessionRef || path.resolve(record.session.file) === normalized) return record;
	}
	return undefined;
}

export interface MutationResult<T> {
	record: T;
}

/**
 * Read-modify-write a record under its cross-process lease. The callback must
 * persist through {@link saveRecord}, which validates transitions.
 */
export function mutateRecord<T>(
	sessionId: string,
	paths: HibernationPaths,
	mutate: (record: HibernationRecord) => { record: HibernationRecord; result: T },
): T {
	const file = recordPath(sessionId, paths);
	return withFileLockSync(
		file,
		() => {
			const record = readRecordFile(file);
			const { record: next, result } = mutate(record);
			saveRecord(file, next, paths, record.history.length);
			return result;
		},
		RECORD_MUTEX_OPTIONS,
	);
}

/** Persist a record, appending every new history transition to the journal. */
export function saveRecord(
	file: string,
	record: HibernationRecord,
	paths = hibernationPaths(),
	previousHistoryLength = record.history.length,
): void {
	const updated: HibernationRecord = { ...record, updatedAt: new Date().toISOString() };
	writeRecordFile(file, updated);
	appendJournal(
		{
			at: updated.updatedAt,
			event: "record_saved",
			registrationId: updated.registrationId,
			sessionId: updated.session.id,
			state: updated.state,
			generation: updated.generation,
		},
		paths,
	);
	for (const entry of updated.history.slice(previousHistoryLength)) {
		appendJournal(
			{
				at: entry.at,
				event: "state_transition",
				registrationId: updated.registrationId,
				sessionId: updated.session.id,
				state: entry.to,
				previous: entry.from ?? undefined,
				...(entry.detail !== undefined && { detail: entry.detail }),
			},
			paths,
		);
	}
}

/** Transition a record in memory; throws when the edge is not legal. */
export function transition(
	record: HibernationRecord,
	to: HibernationState,
	detail?: string,
): HibernationRecord {
	const from = record.state;
	if (from === to) return record;
	if (!canTransition(from, to)) {
		throw new Error(`illegal hibernation transition ${from} -> ${to}`);
	}
	const at = new Date().toISOString();
	return {
		...record,
		state: to,
		updatedAt: at,
		history: [...record.history, { from, to, at, ...(detail !== undefined && { detail }) }],
	};
}

export function diagnose(
	record: HibernationRecord,
	level: "info" | "warning" | "error",
	message: string,
	detail?: string,
): HibernationRecord {
	const entry = {
		at: new Date().toISOString(),
		level,
		message,
		...(detail !== undefined && { detail }),
	};
	return { ...record, updatedAt: entry.at, diagnostics: [...record.diagnostics.slice(-199), entry] };
}

/** Take the wake lease for a session. Held for the life of the process. */
export function acquireWakeLease(sessionId: string, paths = hibernationPaths()): FileLockHandle | null {
	ensureHibernationDirs(paths);
	return tryAcquireFileLock(path.join(paths.root, "wake", sessionKey(sessionId)));
}

export function wakeLeasePath(sessionId: string, paths = hibernationPaths()): string {
	return path.join(paths.root, "wake", sessionKey(sessionId));
}

export type ClaimOutcome =
	| { status: "claimed"; record: HibernationRecord; event: WakeEvent }
	| { status: "already_consumed"; record: HibernationRecord; event: WakeEvent }
	| { status: "busy"; record: HibernationRecord; event: WakeEvent; holder: ProcessIdentity }
	| { status: "missing"; record: HibernationRecord };

/**
 * Atomically claim one wake event for this process.
 *
 * The claim is the logical exactly-once gate: a duplicate wake launch reads the
 * same record, sees `consumedAt`, and does nothing. A claim whose holder died
 * may be reclaimed only when `allowReclaim` is set (manual recovery), so a
 * benign crash does not silently double-deliver by default.
 */
export function claimWakeEvent(
	sessionId: string,
	eventId: string,
	holder: ProcessIdentity,
	options: { allowReclaim?: boolean } = {},
	paths = hibernationPaths(),
): ClaimOutcome {
	return mutateRecord<ClaimOutcome>(sessionId, paths, record => {
		const event = record.wake.events.find(candidate => candidate.id === eventId);
		if (!event) return { record, result: { status: "missing", record } };
		if (event.consumedAt) {
			return { record, result: { status: "already_consumed", record, event } };
		}
		const previousHolder = event.claimedBy;
		if (previousHolder) {
			const sameProcess = isSameProcess(previousHolder, holder);
			const probe = probeProcessIdentity(previousHolder);
			// A live holder always wins; a dead holder may be reclaimed only when
			// an operator or a retry policy asks for it. The same process asking
			// twice is a duplicate launch, not a recovery.
			if (!options.allowReclaim) {
				return { record, result: { status: "busy", record, event, holder: previousHolder } };
			}
			record = diagnose(
				record,
				"warning",
				`reclaiming wake ${eventId} from ${sameProcess ? "this process" : "a dead holder"}`,
				`${previousHolder.pid}: ${probe.reason}`,
			);
		}
		const claimedAt = new Date().toISOString();
		const generation = record.generation + 1;
		const nextEvent: WakeEvent = {
			...event,
			claimedAt,
			claimedBy: holder,
			generation,
		};
		let next: HibernationRecord = {
			...record,
			generation,
			updatedAt: claimedAt,
			wake: {
				...record.wake,
				events: record.wake.events.map(candidate => (candidate.id === eventId ? nextEvent : candidate)),
			},
		};
		if (next.state === "HIBERNATED") next = transition(next, "WAKE_PENDING", `wake ${eventId} arrived`);
		next = transition(next, "RESUMING", `wake ${eventId} claimed by pid ${holder.pid}`);
		return { record: next, result: { status: "claimed", record: next, event: nextEvent } };
	});
}

function isSameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.startTicks === right.startTicks &&
		(left.bootId ?? "") === (right.bootId ?? "")
	);
}

export function consumeWakeEvent(
	sessionId: string,
	eventId: string,
	options: {
		outcome: NonNullable<WakeEvent["outcome"]>;
		detail?: string;
		sessionSizeBefore?: number;
		sessionSizeAfter?: number;
	},
	paths = hibernationPaths(),
): HibernationRecord {
	const holder = currentProcessIdentity();
	return mutateRecord(sessionId, paths, record => {
		const event = record.wake.events.find(candidate => candidate.id === eventId);
		if (!event) throw new Error(`wake event ${eventId} is not recorded`);
		const at = new Date().toISOString();
		const consumed: WakeEvent = {
			...event,
			consumedAt: at,
			outcome: options.outcome,
			...(options.detail !== undefined && { detail: options.detail }),
		};
		let next: HibernationRecord = {
			...record,
			updatedAt: at,
			wake: {
				...record.wake,
				events: record.wake.events.map(candidate => (candidate.id === eventId ? consumed : candidate)),
			},
		};
		if (options.outcome === "resumed") {
			next = transition(next, "ACTIVE", `wake ${eventId} resumed the session`);
			next = {
				...next,
				resume: {
					at,
					by: holder,
					sessionSizeBefore: options.sessionSizeBefore ?? 0,
					sessionSizeAfter: options.sessionSizeAfter ?? 0,
					eventId,
				},
			};
		} else if (options.outcome === "error") {
			next = transition(next, "RECOVERY_REQUIRED", `wake ${eventId} failed`);
		}
		return { record: next, result: next };
	});
}

export function appendWakeEvent(
	sessionId: string,
	event: WakeEvent,
	paths = hibernationPaths(),
): HibernationRecord {
	return mutateRecord(sessionId, paths, record => {
		if (record.wake.events.some(candidate => candidate.id === event.id)) return { record, result: record };
		let next: HibernationRecord = {
			...record,
			updatedAt: new Date().toISOString(),
			wake: { ...record.wake, events: [...record.wake.events, event] },
		};
		if (next.state === "HIBERNATED") {
			next = transition(next, "WAKE_PENDING", `wake ${event.id} (${event.kind})`);
		}
		return { record: next, result: next };
	});
}

export interface RecoveryFinding {
	record: HibernationRecord;
	action: "mark-recovery" | "resume" | "none";
	detail: string;
}

/**
 * Inspect records that claim to be in flight and decide what a recovery pass
 * should do. This never launches work; callers must opt in per finding.
 */
export function inspectRecovery(paths = hibernationPaths()): RecoveryFinding[] {
	const findings: RecoveryFinding[] = [];
	for (const record of listRecords(paths)) {
		if (!isHibernatingState(record.state)) continue;
		const owner = probeProcessIdentity(record.owner);
		const pending = record.wake.events.find(event => !event.consumedAt);
		if (record.state === "RESUMING") {
			const holder = pending?.claimedBy;
			const holderAlive = holder ? probeProcessIdentity(holder).alive : false;
			findings.push({
				record,
				action: holderAlive ? "none" : "mark-recovery",
				detail: holderAlive
					? `wake ${pending?.id ?? "?"} owned by live pid ${holder?.pid}`
					: `resume claim ${pending?.id ?? "?"} has no live holder`,
			});
			continue;
		}
		if (record.state === "PREPARING" && !owner.alive) {
			findings.push({
				record,
				action: "mark-recovery",
				detail: `preparing owner pid ${record.owner.pid} is gone (${owner.reason})`,
			});
			continue;
		}
		if (record.state === "WAKE_PENDING" && pending) {
			findings.push({ record, action: "resume", detail: `wake ${pending.id} is pending` });
			continue;
		}
		if (record.state === "HIBERNATED") {
			findings.push({ record, action: "none", detail: "waiting for the watcher" });
		}
	}
	return findings;
}
