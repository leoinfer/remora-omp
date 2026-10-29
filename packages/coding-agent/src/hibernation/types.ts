/**
 * Durable hibernation records.
 *
 * A hibernation record is the durable link between one OMP session and one
 * externally supervised job. It is deliberately plain JSON: it must stay
 * readable by an operator, by `omp hibernate status`, and by the external
 * watcher without importing OMP code.
 *
 * Nothing here serializes model state. The conversation stays in the session
 * JSONL; this record only names the session, the job, the supervision
 * identity, the wake events, and the outcome.
 */

import { isRecord } from "@oh-my-pi/pi-utils";

export const HIBERNATION_RECORD_VERSION = 1;

/**
 * Lifecycle states. The happy path is
 * `PREPARING -> HIBERNATED -> WAKE_PENDING -> RESUMING -> ACTIVE`.
 * Every other state is terminal or explicitly recoverable; see
 * {@link canTransition}.
 */
export type HibernationState =
	| "PREPARING"
	| "HIBERNATED"
	| "WAKE_PENDING"
	| "RESUMING"
	| "ACTIVE"
	| "CANCELLED"
	| "FAILED"
	| "TIMED_OUT"
	| "RECOVERY_REQUIRED"
	| "EXPIRED";

export type WakeKind = "completed" | "failed" | "timeout" | "stalled" | "cancelled" | "manual";

export type ResumePolicy = "auto" | "manual";

export type JobLaunchKind = "systemd-user-transient" | "attach";

/** Host and process identity that survives PID reuse. */
export interface ProcessIdentity {
	pid: number;
	/** Linux `/proc/<pid>/stat` field 22 (starttime, clock ticks since boot). */
	startTicks?: number;
	/** Kernel boot id at the time the process was observed. */
	bootId?: string;
	hostname?: string;
	/** Wall-clock observation, for diagnostics. */
	observedAt?: string;
}

export interface SessionIdentity {
	id: string;
	/** Absolute path of the session JSONL at hibernation time. */
	file: string;
	/** sha256 of the session header line (id + cwd + version), to detect replacement. */
	headerSha256: string;
	/** Working directory recorded in the session header. */
	cwd: string;
}

export interface RepoIdentity {
	root?: string;
	head?: string;
	branch?: string;
	dirty?: boolean;
}

/** The experiment specification as launched by OMP. */
export interface HibernationJob {
	/** Stable caller-chosen id, also used in the systemd unit name. */
	id: string;
	/** Unique run id for this attempt (record-scoped). */
	runId: string;
	/** Exact shell command, executed locally in `cwd` under systemd. */
	command?: string;
	/** sha256 of `command`, to detect drift between record and unit. */
	commandSha256?: string;
	cwd: string;
	/** User systemd unit that owns the job. */
	unit: string;
	/** systemd InvocationID captured at launch, when available. */
	invocationId?: string;
	/** Where the runner writes its result contract and logs. */
	resultDir: string;
	startedAt: string;
	timeoutMs: number;
	/** Paths that must exist and be non-empty before completion counts. */
	requiredArtifacts: string[];
	/** Exit codes that count as success. Defaults to [0]. */
	successExitCodes: number[];
	launch: JobLaunchKind;
}

/** One durable wake notification derived from a job observation. */
export interface WakeEvent {
	/** Stable wake id, unique per registration generation. */
	id: string;
	kind: WakeKind;
	/** Monotonic generation this event belongs to. */
	generation: number;
	createdAt: string;
	deliveredAt?: string;
	claimedAt?: string;
	claimedBy?: ProcessIdentity;
	consumedAt?: string;
	outcome?: "resumed" | "notified" | "cancelled" | "error";
	detail?: string;
}

/** Wake rules the watcher applies. */
export interface WakeCondition {
	/** Completion requires an observed process exit (or a complete result contract). */
	onExit: boolean;
	/** Require every {@link HibernationJob.requiredArtifacts} path to be complete. */
	requireArtifacts: boolean;
	/** Maximum wall time the job may run before TIMED_OUT. */
	maxWaitMs: number;
}

/** Structured handoff for the resumed turn. */
export interface HibernationIntent {
	objective: string;
	hypothesis?: string;
	successCriteria?: string;
	lastAction?: string;
	nextActions?: string[];
}

/** Watcher registration state, mirrored from the node acknowledgement. */
export interface WatcherRegistration {
	/** Local node socket used at registration time. */
	socket: string;
	mode: "required" | "local-only";
	registrationId: string;
	/** Coordinator epoch acknowledged by the node, when it has one. */
	epoch?: number;
	registeredAt?: string;
	ackAt?: string;
	/** Whether the external coordinator acknowledged durable storage. */
	coordinatorAcked: boolean;
	lastError?: string;
}

/** Result contract written by the job runner and verified by the watcher. */
export interface JobResult {
	version: number;
	runId: string;
	unit: string;
	commandSha256: string;
	startedAt: string;
	finishedAt: string;
	exitCode: number;
	signal?: string;
	durationMs: number;
	stdoutPath: string;
	stderrPath: string;
	artifacts: ArtifactDigest[];
}

export interface ArtifactDigest {
	path: string;
	size: number;
	sha256: string;
}

export interface HibernationDiagnostic {
	at: string;
	level: "info" | "warning" | "error";
	message: string;
	detail?: string;
}

export interface HibernationRecord {
	version: typeof HIBERNATION_RECORD_VERSION;
	/** Stable id used by the watcher and in every journal line. */
	registrationId: string;
	session: SessionIdentity;
	repo?: RepoIdentity;
	job: HibernationJob;
	owner: ProcessIdentity;
	host: {
		hostname: string;
		bootId?: string;
		ompVersion: string;
		ompCommit?: string;
	};
	watcher: WatcherRegistration;
	wake: {
		condition: WakeCondition;
		policy: ResumePolicy;
		estimatedWaitMs: number;
		intent: HibernationIntent;
		events: WakeEvent[];
	};
	state: HibernationState;
	/** Increments per wake attempt; fencing token for events. */
	generation: number;
	createdAt: string;
	updatedAt: string;
	history: Array<{ from: HibernationState | null; to: HibernationState; at: string; detail?: string }>;
	result?: JobResult;
	/** Set after a successful resumption. */
	resume?: {
		at: string;
		by: ProcessIdentity;
		sessionSizeBefore: number;
		sessionSizeAfter: number;
		eventId: string;
	};
	diagnostics: HibernationDiagnostic[];
}

const VALID_TRANSITIONS: Record<HibernationState, readonly HibernationState[]> = {
	PREPARING: ["HIBERNATED", "FAILED", "CANCELLED"],
	HIBERNATED: ["WAKE_PENDING", "TIMED_OUT", "CANCELLED", "EXPIRED", "RECOVERY_REQUIRED"],
	WAKE_PENDING: ["RESUMING", "CANCELLED", "TIMED_OUT", "EXPIRED"],
	RESUMING: ["ACTIVE", "RECOVERY_REQUIRED", "FAILED"],
	ACTIVE: ["PREPARING"],
	CANCELLED: ["PREPARING"],
	FAILED: ["PREPARING", "RECOVERY_REQUIRED"],
	TIMED_OUT: ["PREPARING", "RECOVERY_REQUIRED", "CANCELLED"],
	RECOVERY_REQUIRED: ["RESUMING", "ACTIVE", "CANCELLED", "FAILED"],
	EXPIRED: [],
};

export function canTransition(from: HibernationState, to: HibernationState): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].includes(to);
}

export function isTerminalState(state: HibernationState): boolean {
	return state === "ACTIVE" || state === "CANCELLED" || state === "EXPIRED";
}

export function isHibernatingState(state: HibernationState): boolean {
	return state === "PREPARING" || state === "HIBERNATED" || state === "WAKE_PENDING" || state === "RESUMING";
}

/** A record is stale when its owner process is gone or its boot id changed. */
export interface OwnerLiveness {
	alive: boolean;
	reason: string;
}

function str(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`hibernation record: ${field} must be a string`);
	return value;
}

function num(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`hibernation record: ${field} must be a finite number`);
	}
	return value;
}

function bool(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`hibernation record: ${field} must be a boolean`);
	return value;
}

function strArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new Error(`hibernation record: ${field} must be an array of strings`);
	}
	return value as string[];
}

/**
 * Parse a record read from disk or received over the watcher socket.
 * Throws on malformed input instead of trusting a cast.
 */
export function parseHibernationRecord(value: unknown): HibernationRecord {
	if (!isRecord(value)) throw new Error("hibernation record: not an object");
	if (value.version !== HIBERNATION_RECORD_VERSION) {
		throw new Error(`hibernation record: unsupported version ${String(value.version)}`);
	}
	const sessionRaw = value.session;
	if (!isRecord(sessionRaw)) throw new Error("hibernation record: session missing");
	const jobRaw = value.job;
	if (!isRecord(jobRaw)) throw new Error("hibernation record: job missing");
	const ownerRaw = value.owner;
	if (!isRecord(ownerRaw)) throw new Error("hibernation record: owner missing");
	const hostRaw = value.host;
	if (!isRecord(hostRaw)) throw new Error("hibernation record: host missing");
	const watcherRaw = value.watcher;
	if (!isRecord(watcherRaw)) throw new Error("hibernation record: watcher missing");
	const wakeRaw = value.wake;
	if (!isRecord(wakeRaw)) throw new Error("hibernation record: wake missing");
	const conditionRaw = wakeRaw.condition;
	if (!isRecord(conditionRaw)) throw new Error("hibernation record: wake.condition missing");
	const intentRaw = wakeRaw.intent;
	if (!isRecord(intentRaw)) throw new Error("hibernation record: wake.intent missing");
	const state = str(value.state, "state") as HibernationState;
	if (!(state in VALID_TRANSITIONS)) throw new Error(`hibernation record: unknown state ${state}`);
	const eventsRaw = wakeRaw.events;
	if (!Array.isArray(eventsRaw)) throw new Error("hibernation record: wake.events must be an array");

	const events: WakeEvent[] = eventsRaw.map((event, index) => {
		if (!isRecord(event)) throw new Error(`hibernation record: wake.events[${index}] not an object`);
		return {
			id: str(event.id, `wake.events[${index}].id`),
			kind: str(event.kind, `wake.events[${index}].kind`) as WakeKind,
			generation: num(event.generation, `wake.events[${index}].generation`),
			createdAt: str(event.createdAt, `wake.events[${index}].createdAt`),
			...(typeof event.deliveredAt === "string" && { deliveredAt: event.deliveredAt }),
			...(typeof event.claimedAt === "string" && { claimedAt: event.claimedAt }),
			...(isRecord(event.claimedBy) && {
				claimedBy: parseProcessIdentity(event.claimedBy, `wake.events[${index}].claimedBy`),
			}),
			...(typeof event.consumedAt === "string" && { consumedAt: event.consumedAt }),
			...(typeof event.outcome === "string" && { outcome: event.outcome as WakeEvent["outcome"] }),
			...(typeof event.detail === "string" && { detail: event.detail }),
		};
	});

	const historyRaw = Array.isArray(value.history) ? value.history : [];
	const diagnosticsRaw = Array.isArray(value.diagnostics) ? value.diagnostics : [];

	return {
		version: HIBERNATION_RECORD_VERSION,
		registrationId: str(value.registrationId, "registrationId"),
		session: {
			id: str(sessionRaw.id, "session.id"),
			file: str(sessionRaw.file, "session.file"),
			headerSha256: str(sessionRaw.headerSha256, "session.headerSha256"),
			cwd: str(sessionRaw.cwd, "session.cwd"),
		},
		...(isRecord(value.repo) && {
			repo: {
				...(typeof value.repo.root === "string" && { root: value.repo.root }),
				...(typeof value.repo.head === "string" && { head: value.repo.head }),
				...(typeof value.repo.branch === "string" && { branch: value.repo.branch }),
				...(typeof value.repo.dirty === "boolean" && { dirty: value.repo.dirty }),
			},
		}),
		job: {
			id: str(jobRaw.id, "job.id"),
			runId: str(jobRaw.runId, "job.runId"),
			...(typeof jobRaw.command === "string" && { command: jobRaw.command }),
			...(typeof jobRaw.commandSha256 === "string" && { commandSha256: jobRaw.commandSha256 }),
			cwd: str(jobRaw.cwd, "job.cwd"),
			unit: str(jobRaw.unit, "job.unit"),
			...(typeof jobRaw.invocationId === "string" && { invocationId: jobRaw.invocationId }),
			resultDir: str(jobRaw.resultDir, "job.resultDir"),
			startedAt: str(jobRaw.startedAt, "job.startedAt"),
			timeoutMs: num(jobRaw.timeoutMs, "job.timeoutMs"),
			requiredArtifacts: strArray(jobRaw.requiredArtifacts, "job.requiredArtifacts"),
			successExitCodes: jobRaw.successExitCodes === undefined ? [0] : numArray(jobRaw.successExitCodes, "job.successExitCodes"),
			launch: str(jobRaw.launch, "job.launch") as JobLaunchKind,
		},
		owner: parseProcessIdentity(ownerRaw, "owner"),
		host: {
			hostname: str(hostRaw.hostname, "host.hostname"),
			...(typeof hostRaw.bootId === "string" && { bootId: hostRaw.bootId }),
			ompVersion: str(hostRaw.ompVersion, "host.ompVersion"),
			...(typeof hostRaw.ompCommit === "string" && { ompCommit: hostRaw.ompCommit }),
		},
		watcher: {
			socket: str(watcherRaw.socket, "watcher.socket"),
			mode: str(watcherRaw.mode, "watcher.mode") as WatcherRegistration["mode"],
			registrationId: str(watcherRaw.registrationId, "watcher.registrationId"),
			...(typeof watcherRaw.epoch === "number" && { epoch: watcherRaw.epoch }),
			...(typeof watcherRaw.registeredAt === "string" && { registeredAt: watcherRaw.registeredAt }),
			...(typeof watcherRaw.ackAt === "string" && { ackAt: watcherRaw.ackAt }),
			coordinatorAcked: bool(watcherRaw.coordinatorAcked, "watcher.coordinatorAcked"),
			...(typeof watcherRaw.lastError === "string" && { lastError: watcherRaw.lastError }),
		},
		wake: {
			condition: {
				onExit: bool(conditionRaw.onExit, "wake.condition.onExit"),
				requireArtifacts: bool(conditionRaw.requireArtifacts, "wake.condition.requireArtifacts"),
				maxWaitMs: num(conditionRaw.maxWaitMs, "wake.condition.maxWaitMs"),
			},
			policy: str(wakeRaw.policy, "wake.policy") as ResumePolicy,
			estimatedWaitMs: num(wakeRaw.estimatedWaitMs, "wake.estimatedWaitMs"),
			intent: {
				objective: str(intentRaw.objective, "wake.intent.objective"),
				...(typeof intentRaw.hypothesis === "string" && { hypothesis: intentRaw.hypothesis }),
				...(typeof intentRaw.successCriteria === "string" && { successCriteria: intentRaw.successCriteria }),
				...(typeof intentRaw.lastAction === "string" && { lastAction: intentRaw.lastAction }),
				...(intentRaw.nextActions !== undefined && {
					nextActions: strArray(intentRaw.nextActions, "wake.intent.nextActions"),
				}),
			},
			events,
		},
		state,
		generation: num(value.generation, "generation"),
		createdAt: str(value.createdAt, "createdAt"),
		updatedAt: str(value.updatedAt, "updatedAt"),
		history: historyRaw.map((entry, index) => {
			if (!isRecord(entry)) throw new Error(`hibernation record: history[${index}] not an object`);
			return {
				from: entry.from === null ? null : (str(entry.from, `history[${index}].from`) as HibernationState),
				to: str(entry.to, `history[${index}].to`) as HibernationState,
				at: str(entry.at, `history[${index}].at`),
				...(typeof entry.detail === "string" && { detail: entry.detail }),
			};
		}),
		...(isRecord(value.result) && { result: parseJobResult(value.result) }),
		...(isRecord(value.resume) && {
			resume: {
				at: str(value.resume.at, "resume.at"),
				by: isRecord(value.resume.by)
					? parseProcessIdentity(value.resume.by, "resume.by")
					: (() => {
							throw new Error("hibernation record: resume.by must be an object");
						})(),
				sessionSizeBefore: num(value.resume.sessionSizeBefore, "resume.sessionSizeBefore"),
				sessionSizeAfter: num(value.resume.sessionSizeAfter, "resume.sessionSizeAfter"),
				eventId: str(value.resume.eventId, "resume.eventId"),
			},
		}),
		diagnostics: diagnosticsRaw.map((entry, index) => {
			if (!isRecord(entry)) throw new Error(`hibernation record: diagnostics[${index}] not an object`);
			return {
				at: str(entry.at, `diagnostics[${index}].at`),
				level: str(entry.level, `diagnostics[${index}].level`) as HibernationDiagnostic["level"],
				message: str(entry.message, `diagnostics[${index}].message`),
				...(typeof entry.detail === "string" && { detail: entry.detail }),
			};
		}),
	};
}

function numArray(value: unknown, field: string): number[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "number" || !Number.isFinite(item))) {
		throw new Error(`hibernation record: ${field} must be an array of numbers`);
	}
	return value;
}

function parseProcessIdentity(value: Record<string, unknown>, field: string): ProcessIdentity {
	return {
		pid: num(value.pid, `${field}.pid`),
		...(typeof value.startTicks === "number" && { startTicks: value.startTicks }),
		...(typeof value.bootId === "string" && { bootId: value.bootId }),
		...(typeof value.hostname === "string" && { hostname: value.hostname }),
		...(typeof value.observedAt === "string" && { observedAt: value.observedAt }),
	};
}

export function parseJobResult(value: unknown): JobResult {
	if (!isRecord(value)) throw new Error("job result: not an object");
	const artifactsRaw = value.artifacts;
	if (!Array.isArray(artifactsRaw)) throw new Error("job result: artifacts must be an array");
	return {
		version: num(value.version, "result.version"),
		runId: str(value.runId, "result.runId"),
		unit: str(value.unit, "result.unit"),
		commandSha256: str(value.commandSha256, "result.commandSha256"),
		startedAt: str(value.startedAt, "result.startedAt"),
		finishedAt: str(value.finishedAt, "result.finishedAt"),
		exitCode: num(value.exitCode, "result.exitCode"),
		...(typeof value.signal === "string" && { signal: value.signal }),
		durationMs: num(value.durationMs, "result.durationMs"),
		stdoutPath: str(value.stdoutPath, "result.stdoutPath"),
		stderrPath: str(value.stderrPath, "result.stderrPath"),
		artifacts: artifactsRaw.map((artifact, index) => {
			if (!isRecord(artifact)) throw new Error(`job result: artifacts[${index}] not an object`);
			return {
				path: str(artifact.path, `artifacts[${index}].path`),
				size: num(artifact.size, `artifacts[${index}].size`),
				sha256: str(artifact.sha256, `artifacts[${index}].sha256`),
			};
		}),
	};
}
