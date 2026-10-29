/**
 * Hibernation lifecycle service.
 *
 * One session, one record, one job. The service validates that the job can
 * outlive OMP, launches it under systemd, registers it with the watcher, and
 * only then lets the caller leave the session. On the way back in, it claims a
 * durable wake event before launching the agent, so duplicate wake deliveries
 * cannot produce competing agents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { logger, toError } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "../session/session-manager";
import {
	appendWakeEvent,
	claimWakeEvent,
	consumeWakeEvent,
	currentProcessIdentity,
	diagnose,
	findRecord,
	hibernationPaths,
	type HibernationPaths,
	listRecords,
	probeProcessIdentity,
	readSessionHeaderIdentity,
	recordPath,
	saveRecord,
	sessionFileSize,
	transition,
} from "./store";
import {
	launchJob,
	observeJob,
	probeUnit,
	readJobResult,
	stopUnit,
	verifyArtifacts,
} from "./job";
import { WatcherClient, WatcherError } from "./watcher";
import {
	cfgHibernationMaxWaitSeconds,
	cfgHibernationMinWaitSeconds,
	cfgHibernationResumePolicy,
	cfgHibernationSocket,
	cfgHibernationStallSeconds,
	cfgHibernationTokenFile,
	cfgHibernationWatcherMode,
	resolveResumePolicy,
} from "./settings";
import type { Settings } from "../config/settings";
import {
	type HibernationIntent,
	type HibernationRecord,
	HIBERNATION_RECORD_VERSION,
	type JobResult,
	type RepoIdentity,
	type ResumePolicy,
	type WakeCondition,
	type WakeEvent,
} from "./types";

export interface HibernationPolicyInput {
	estimatedWaitMs: number;
	minWaitMs: number;
	pendingAsyncJobs: number;
	hasQueuedMessages: boolean;
	independentWorkAvailable: boolean;
}

export interface PolicyDecision {
	allow: boolean;
	reason: string;
	/** Rough inference cost of one resume turn, for the operator's judgment. */
	resumeOverhead: string;
}

/**
 * Decide whether hibernating beats staying alive. Deliberately conservative:
 * any owned background job would die with the process, and a queued user
 * message means the operator is waiting.
 */
export function evaluateHibernationPolicy(input: HibernationPolicyInput): PolicyDecision {
	if (input.hasQueuedMessages) {
		return { allow: false, reason: "queued user messages are waiting; finish or cancel them first", resumeOverhead: "n/a" };
	}
	if (input.pendingAsyncJobs > 0) {
		return {
			allow: false,
			reason: `${input.pendingAsyncJobs} owned background job(s) would be cancelled by exiting; wait, collect them, or force`,
			resumeOverhead: "n/a",
		};
	}
	if (input.estimatedWaitMs < input.minWaitMs) {
		return {
			allow: false,
			reason: `estimated wait ${Math.round(input.estimatedWaitMs / 1000)}s is below the ${Math.round(
				input.minWaitMs / 1000,
			)}s threshold; staying active is cheaper`,
			resumeOverhead: "one resume turn (system prompt + transcript)",
		};
	}
	if (input.independentWorkAvailable) {
		return {
			allow: true,
			reason: "wait is long enough; independent work is available, so consider doing it first",
			resumeOverhead: "one resume turn (system prompt + transcript)",
		};
	}
	return {
		allow: true,
		reason: "wait exceeds the threshold and no work would be lost",
		resumeOverhead: "one resume turn (system prompt + transcript)",
	};
}

export interface RegisterHibernationInput {
	sessionManager: Pick<SessionManager, "getSessionId" | "getSessionFile" | "getCwd">;
	jobId: string;
	command: string;
	cwd?: string;
	timeoutSeconds?: number;
	estimatedWaitSeconds: number;
	requiredArtifacts?: string[];
	successExitCodes?: number[];
	intent: HibernationIntent;
	settings: Settings;
	force?: boolean;
	allowDegraded?: boolean;
	resumePolicy?: ResumePolicy;
	pendingAsyncJobs?: number;
	hasQueuedMessages?: boolean;
	paths?: HibernationPaths;
	watcher?: WatcherClient;
}

export interface RegisterHibernationResult {
	record: HibernationRecord;
	ack: {
		accepted: boolean;
		registrationId: string;
		epoch?: number;
		coordinatorAcked: boolean;
		alreadyComplete: boolean;
	};
}

function repoIdentity(cwd: string): RepoIdentity | undefined {
	const run = (argv: string[]): string | undefined => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...argv], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 3000,
		});
		if (result.exitCode !== 0) return undefined;
		return new TextDecoder().decode(result.stdout).trim() || undefined;
	};
	const root = run(["rev-parse", "--show-toplevel"]);
	if (!root) return undefined;
	return {
		root,
		head: run(["rev-parse", "HEAD"]),
		branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
		dirty: run(["status", "--porcelain"]) !== undefined,
	};
}

function buildWakeCondition(input: RegisterHibernationInput, settings: Settings): WakeCondition {
	const maxWaitMs = Math.min(
		(input.timeoutSeconds ?? cfgHibernationMaxWaitSeconds.get(settings)) * 1000,
		cfgHibernationMaxWaitSeconds.get(settings) * 1000,
	);
	return {
		onExit: true,
		requireArtifacts: (input.requiredArtifacts?.length ?? 0) > 0,
		maxWaitMs,
	};
}

function assertNoActiveRecord(sessionId: string, paths: HibernationPaths): void {
	const existing = findRecord(sessionId, paths);
	if (!existing) return;
	if (
		existing.state === "HIBERNATED" ||
		existing.state === "WAKE_PENDING" ||
		existing.state === "RESUMING" ||
		existing.state === "PREPARING"
	) {
		throw new Error(
			`session ${sessionId} already has a ${existing.state} hibernation (${existing.registrationId}); ` +
				`run \`omp hibernate status --session ${sessionId}\` or cancel it first`,
		);
	}
}

/**
 * Launch the job, persist the record, and obtain a watcher acknowledgement.
 * A failure after launch leaves the job running (it is independent) and
 * records the failure; it never exits the agent.
 */
export async function registerHibernation(input: RegisterHibernationInput): Promise<RegisterHibernationResult> {
	const paths = input.paths ?? hibernationPaths();
	const sessionFile = input.sessionManager.getSessionFile();
	const sessionId = input.sessionManager.getSessionId();
	if (!sessionFile) throw new Error("hibernation requires a persisted session; start without --no-session");
	if (!fs.existsSync(sessionFile)) throw new Error(`session file does not exist: ${sessionFile}`);
	const header = readSessionHeaderIdentity(sessionFile);
	if (header.id !== sessionId) {
		throw new Error(`session header id ${header.id} does not match the active session ${sessionId}`);
	}
	assertNoActiveRecord(sessionId, paths);

	const minWaitMs = cfgHibernationMinWaitSeconds.get(input.settings) * 1000;
	const estimatedWaitMs = input.estimatedWaitSeconds * 1000;
	const decision = evaluateHibernationPolicy({
		estimatedWaitMs,
		minWaitMs,
		pendingAsyncJobs: input.pendingAsyncJobs ?? 0,
		hasQueuedMessages: input.hasQueuedMessages ?? false,
		independentWorkAvailable: false,
	});
	if (!decision.allow && !input.force) throw new Error(`hibernation refused: ${decision.reason}`);

	const cwd = input.cwd ?? input.sessionManager.getCwd();
	const timeoutSeconds = Math.min(
		input.timeoutSeconds ?? cfgHibernationMaxWaitSeconds.get(input.settings),
		cfgHibernationMaxWaitSeconds.get(input.settings),
	);
	const launched = launchJob({
		jobId: input.jobId,
		command: input.command,
		cwd,
		timeoutMs: timeoutSeconds * 1000,
		requiredArtifacts: input.requiredArtifacts ?? [],
		successExitCodes: input.successExitCodes ?? [0],
		paths,
	});

	const now = new Date().toISOString();
	const watcherMode = cfgHibernationWatcherMode.get(input.settings);
	let record: HibernationRecord = {
		version: HIBERNATION_RECORD_VERSION,
		registrationId: `hib-${Date.now().toString(36)}-${createHash("sha256")
			.update(`${sessionId}:${launched.job.runId}`)
			.digest("hex")
			.slice(0, 8)}`,
		session: {
			id: sessionId,
			file: sessionFile,
			headerSha256: header.headerSha256,
			cwd,
		},
		repo: repoIdentity(cwd),
		job: launched.job,
		owner: currentProcessIdentity(),
		host: {
			hostname: os.hostname(),
			...(currentProcessIdentity().bootId !== undefined && { bootId: currentProcessIdentity().bootId }),
			ompVersion: VERSION,
		},
		watcher: {
			socket: input.watcher?.socket ?? cfgHibernationSocket.get(input.settings) ?? "",
			mode: watcherMode === "local-only" ? "local-only" : "required",
			registrationId: "",
			coordinatorAcked: false,
		},
		wake: {
			condition: buildWakeCondition({ ...input, timeoutSeconds }, input.settings),
			policy: input.resumePolicy ?? resolveResumePolicy(cfgHibernationResumePolicy.get(input.settings)),
			estimatedWaitMs,
			intent: input.intent,
			events: [],
		},
		state: "PREPARING",
		generation: 0,
		createdAt: now,
		updatedAt: now,
		history: [{ from: null, to: "PREPARING", at: now, detail: `job ${launched.job.unit}` }],
		diagnostics: [],
	};
	record.watcher.registrationId = record.registrationId;
	saveRecord(recordPath(sessionId, paths), record, paths);

	if (watcherMode === "local-only") {
		record = transition(record, "HIBERNATED", "local-only registration; manual wake required");
		record = diagnose(
			record,
			"warning",
			"no external watcher registered; this session will not resume automatically",
		);
		saveRecord(recordPath(sessionId, paths), record, paths);
		return {
			record,
			ack: {
				accepted: true,
				registrationId: record.registrationId,
				coordinatorAcked: false,
				alreadyComplete: false,
			},
		};
	}

	const client =
		input.watcher ??
		new WatcherClient({
			socket: cfgHibernationSocket.get(input.settings) || undefined,
			tokenFile: cfgHibernationTokenFile.get(input.settings) || undefined,
		});
	record = { ...record, watcher: { ...record.watcher, socket: client.socket } };
	try {
		const ack = await client.register(record, 3);
		if (!ack.accepted) throw new Error("watcher refused the hibernation registration");
		if (!ack.coordinator.acked && !input.allowDegraded) {
			throw new Error(
				`watcher node accepted locally but the external coordinator did not acknowledge: ${
					ack.coordinator.detail ?? "no detail"
				}. Re-run with allowDegraded to hibernate with local supervision only.`,
			);
		}
		record = {
			...record,
			watcher: {
				...record.watcher,
				epoch: ack.epoch,
				registeredAt: record.createdAt,
				ackAt: new Date().toISOString(),
				coordinatorAcked: ack.coordinator.acked,
				...(ack.coordinator.detail !== undefined && { lastError: ack.coordinator.detail }),
			},
		};
		record = transition(
			record,
			"HIBERNATED",
			`watcher ack${ack.epoch !== undefined ? ` epoch ${ack.epoch}` : ""}${
				ack.coordinator.acked ? ", coordinator durable" : ", coordinator degraded"
			}`,
		);
		if (ack.alreadyComplete) {
			record = diagnose(record, "info", "job completed before the agent exited; wake will be immediate");
		}
		saveRecord(recordPath(sessionId, paths), record, paths);
		return {
			record,
			ack: {
				accepted: true,
				registrationId: ack.registrationId,
				epoch: ack.epoch,
				coordinatorAcked: ack.coordinator.acked,
				alreadyComplete: ack.alreadyComplete === true,
			},
		};
	} catch (error) {
		const message = error instanceof WatcherError ? `${error.code}: ${error.message}` : toError(error).message;
		record = diagnose(record, "error", "watcher registration failed; not hibernating", message);
		record = transition(record, "FAILED", "watcher registration failed");
		record = {
			...record,
			watcher: { ...record.watcher, lastError: message },
		};
		saveRecord(recordPath(sessionId, paths), record, paths);
		throw new Error(
			`hibernation registration failed; the job (${record.job.unit}) is still running and the session stays active.\n` +
				`${message}\n` +
				`Fix the watcher, then retry; or stop the job with \`systemctl --user stop ${record.job.unit}\`.`,
		);
	}
}

export interface SyncWakeResult {
	record: HibernationRecord;
	added: WakeEvent[];
	error?: string;
}

/**
 * Pull pending wake events the node knows about into the local record. The
 * node is the authority for observed completions; OMP must not wake on a
 * coordinator message alone, but it does need the event id and kind to build
 * the handoff prompt.
 */
export async function syncWakeEvents(
	record: HibernationRecord,
	settings?: Settings,
): Promise<SyncWakeResult> {
	if (record.watcher.mode === "local-only") return { record, added: [] };
	const client = new WatcherClient({
		socket: (settings ? cfgHibernationSocket.get(settings) : undefined) || record.watcher.socket || undefined,
		tokenFile: settings ? cfgHibernationTokenFile.get(settings) || undefined : undefined,
	});
	try {
		const status = await client.status(record.registrationId);
		const known = new Set(record.wake.events.map(event => event.id));
		const added: WakeEvent[] = [];
		let next = record;
		for (const pending of status.wake.pendingEvents) {
			if (!pending.id || known.has(pending.id)) continue;
			const kind = ["completed", "failed", "timeout", "stalled", "cancelled", "manual"].includes(pending.kind)
				? (pending.kind as WakeEvent["kind"])
				: "manual";
			const event: WakeEvent = {
				id: pending.id,
				kind,
				generation: next.generation + 1,
				createdAt: pending.createdAt || new Date().toISOString(),
				deliveredAt: new Date().toISOString(),
			};
			next = appendWakeEvent(record.session.id, event);
			added.push(event);
			known.add(event.id);
		}
		return { record: next, added };
	} catch (error) {
		return { record, added: [], error: toError(error).message };
	}
}

export interface CreateManualWakeResult {
	record: HibernationRecord;
	event: WakeEvent;
}

/** Create an explicit operator wake event when no watcher event exists. */
export function createManualWake(
	record: HibernationRecord,
	reason: string,
	paths: HibernationPaths = hibernationPaths(),
	eventId?: string,
): CreateManualWakeResult {
	const event: WakeEvent = {
		id: eventId ?? `manual-${record.generation + 1}-${Date.now().toString(36)}`,
		kind: "manual",
		generation: record.generation + 1,
		createdAt: new Date().toISOString(),
		detail: reason,
	};
	return { record: appendWakeEvent(record.session.id, event, paths), event };
}

export interface WakePlan {
	record: HibernationRecord;
	event: WakeEvent;
	result?: JobResult;
	artifactSummary: string[];
	prompt: string;
	sessionSizeBefore: number;
}

/** Render the structured handoff for the resumed turn. */
export function buildWakePrompt(plan: Omit<WakePlan, "prompt">): string {
	const { record, event, result } = plan;
	const lines: string[] = [];
	lines.push(`<omp-hibernation-wake id="${event.id}" registration="${record.registrationId}" generation="${event.generation}">`);
	lines.push("");
	lines.push(`This session was hibernated and has just been resumed by the external watcher.`);
	lines.push(`Job: ${record.job.id} (${record.job.unit})`);
	lines.push(`Job event: ${event.kind} at ${event.createdAt}`);
	lines.push(`Result contract: ${path.join(record.job.resultDir, "result.json")}`);
	if (result) {
		lines.push(
			`Process result: exit ${result.exitCode} after ${Math.round(result.durationMs / 1000)}s` +
				(result.signal ? ` (signal ${result.signal})` : ""),
		);
		lines.push(`stdout: ${result.stdoutPath}`);
		lines.push(`stderr: ${result.stderrPath}`);
		for (const artifact of result.artifacts) {
			lines.push(`artifact: ${artifact.path} (${artifact.size} bytes, sha256 ${artifact.sha256.slice(0, 16)}…)`);
		}
	}
	lines.push("");
	lines.push(`Original objective: ${record.wake.intent.objective}`);
	if (record.wake.intent.hypothesis) lines.push(`Hypothesis under test: ${record.wake.intent.hypothesis}`);
	if (record.wake.intent.successCriteria) lines.push(`Success criteria: ${record.wake.intent.successCriteria}`);
	if (record.wake.intent.lastAction) lines.push(`Last committed action: ${record.wake.intent.lastAction}`);
	if (record.wake.intent.nextActions?.length) {
		lines.push("Planned next actions:");
		for (const action of record.wake.intent.nextActions) lines.push(`- ${action}`);
	}
	lines.push("");
	lines.push(`Wake policy: exactly-once at the workflow level. Event ${event.id} is now being consumed;`);
	lines.push(`do not call hibernate for this job again, and do not re-run the experiment to "confirm" it.`);
	lines.push(`Inspect the result and artifacts first, then continue the original objective from the last`);
	lines.push(`committed step. If the result is a failure or incomplete, diagnose it and decide the next`);
	lines.push(`experiment; use hibernation again only when the next wait is long enough to justify it.`);
	lines.push(`When this turn is finished, the event is acknowledged automatically.`);
	lines.push("");
	lines.push(`</omp-hibernation-wake>`);
	return lines.join("\n");
}

export interface PrepareWakeInput {
	sessionRef: string;
	eventId?: string;
	force?: boolean;
	allowReclaim?: boolean;
	/** Create an explicit operator wake event when none is pending. */
	manualReason?: string;
	paths?: HibernationPaths;
}

/**
 * Resolve and claim a pending wake without launching the agent. This is the
 * durable transaction duplicated wake deliveries must pass through.
 */
export function prepareWake(input: PrepareWakeInput): WakePlan {
	const paths = input.paths ?? hibernationPaths();
	const record = findRecord(input.sessionRef, paths);
	if (!record) throw new Error(`no hibernation record for ${input.sessionRef}`);
	if (record.state === "PREPARING") {
		throw new Error("hibernation never completed registration; the agent was not released");
	}
	if (record.state === "CANCELLED" || record.state === "EXPIRED") {
		throw new Error(`hibernation is ${record.state}; nothing to wake`);
	}
	if (!fs.existsSync(record.session.file)) {
		throw new Error(`session file is missing: ${record.session.file}; run \`omp hibernate recover\``);
	}
	try {
		const header = readSessionHeaderIdentity(record.session.file);
		if (header.id !== record.session.id || header.headerSha256 !== record.session.headerSha256) {
			throw new Error(
				`session identity changed since hibernation (id ${header.id}, header ${header.headerSha256.slice(0, 12)}…); refusing to resume the wrong conversation`,
			);
		}
	} catch (error) {
		throw new Error(`cannot verify the hibernated session: ${toError(error).message}`);
	}
	const pending = record.wake.events.filter(event => !event.consumedAt);
	if (record.state === "ACTIVE" && pending.length > 0) {
		// A duplicate completion notification after a successful resume must not
		// start another agent. Consume it as a no-op and report idempotently.
		let consumed: WakeEvent | undefined;
		for (const duplicate of pending) {
			consumed = consumeWakeEvent(
				record.session.id,
				duplicate.id,
				{ outcome: "notified", detail: "session was already active; duplicate notification ignored" },
				paths,
			).wake.events.find(event => event.id === duplicate.id);
		}
		if (consumed) throw new WakeAlreadyConsumedError(consumed);
	}
	if (record.state === "ACTIVE") {
		const last = record.wake.events.at(-1);
		if (last?.consumedAt) throw new WakeAlreadyConsumedError(last);
		throw new Error("the session is already active; nothing to wake");
	}
	const event = input.eventId
		? pending.find(candidate => candidate.id === input.eventId) ?? record.wake.events.find(candidate => candidate.id === input.eventId)
		: pending.at(-1);
	if (!event) {
		if (input.manualReason) {
			createManualWake(record, input.manualReason, paths, input.eventId);
			return prepareWake({ ...input, manualReason: undefined });
		}
		throw new Error("no wake event is pending for this hibernation");
	}
	if (event.consumedAt) {
		throw new WakeAlreadyConsumedError(event);
	}
	if (!input.force) {
		const owner = probeProcessIdentity(record.owner);
		if (owner.alive && record.owner.pid !== process.pid) {
			throw new Error(
				`the session owner pid ${record.owner.pid} is still alive (${owner.reason}); ` +
					`refusing to start a competing agent. Use --force only after verifying that process is stale.`,
			);
		}
	}
	const holder = currentProcessIdentity();
	// claimWakeEvent takes the record lease; the busy outcome is the normal
	// duplicate-wake loser and must stay non-destructive.
	const claim = claimWakeEvent(record.session.id, event.id, holder, { allowReclaim: input.allowReclaim ?? input.force ?? false }, paths);
	if (claim.status === "already_consumed") throw new WakeAlreadyConsumedError(claim.event);
	if (claim.status === "busy") {
		throw new Error(
			`wake ${event.id} is already claimed by pid ${claim.holder.pid}; refusing a concurrent resume`,
		);
	}
	if (claim.status === "missing") throw new Error(`wake ${event.id} is not recorded`);
	const claimedRecord = claim.record;
	const result = readJobResult(claimedRecord.job.resultDir);
	const artifactSummary = result
		? verifyArtifacts(claimedRecord.job, result).artifacts.map(artifact => artifact.path)
		: [];
	const sessionSizeBefore = sessionFileSize(claimedRecord.session.file);
	const plan: Omit<WakePlan, "prompt"> = {
		record: claimedRecord,
		event: claim.event,
		...(result !== undefined && { result }),
		artifactSummary,
		sessionSizeBefore,
	};
	return { ...plan, prompt: buildWakePrompt(plan) };
}

export class WakeAlreadyConsumedError extends Error {
	constructor(readonly event: WakeEvent) {
		super(`wake ${event.id} was already consumed at ${event.consumedAt ?? "unknown time"} (${event.outcome ?? "?"})`);
		this.name = "WakeAlreadyConsumedError";
	}
}

/** Record the outcome of a resumed turn durably. */
export function completeWake(
	plan: WakePlan,
	outcome: { ok: boolean; detail?: string; sessionSizeAfter?: number },
	paths = hibernationPaths(),
): HibernationRecord {
	// Any other event still pending is superseded by the event that actually
	// resumed the session; keep it consumed so status never advertises work
	// that can no longer happen.
	for (const event of plan.record.wake.events) {
		if (event.id === plan.event.id || event.consumedAt) continue;
		try {
			consumeWakeEvent(
				plan.record.session.id,
				event.id,
				{ outcome: "notified", detail: `superseded by wake ${plan.event.id}` },
				paths,
			);
		} catch {}
	}
	return consumeWakeEvent(
		plan.record.session.id,
		plan.event.id,
		{
			outcome: outcome.ok ? "resumed" : "error",
			...(outcome.detail !== undefined && { detail: outcome.detail }),
			sessionSizeBefore: plan.sessionSizeBefore,
			sessionSizeAfter: outcome.sessionSizeAfter ?? sessionFileSize(plan.record.session.file),
		},
		paths,
	);
}

export interface CancellationResult {
	record: HibernationRecord;
	stopped: boolean;
}

export function cancelHibernation(
	sessionRef: string,
	options: { stopJob?: boolean; reason?: string; paths?: HibernationPaths } = {},
): CancellationResult {
	const paths = options.paths ?? hibernationPaths();
	const record = findRecord(sessionRef, paths);
	if (!record) throw new Error(`no hibernation record for ${sessionRef}`);
	const stopped = options.stopJob ? stopUnit(record.job.unit).exitCode === 0 : false;
	const now = new Date().toISOString();
	const cancelledEvent: WakeEvent | undefined =
		record.state === "HIBERNATED"
			? {
					id: `cancel-${record.generation + 1}-${Date.now().toString(36)}`,
					kind: "cancelled",
					generation: record.generation + 1,
					createdAt: now,
					consumedAt: now,
					outcome: "cancelled",
					detail: options.reason ?? "operator cancelled",
				}
			: undefined;
	let next: HibernationRecord = {
		...record,
		...(cancelledEvent !== undefined
			? { wake: { ...record.wake, events: [...record.wake.events, cancelledEvent] } }
			: {}),
	};
	next = transition(next, "CANCELLED", options.reason ?? "operator cancelled");
	next = diagnose(next, "info", "hibernation cancelled", stopped ? "job stopped" : "job left running");
	saveRecord(recordPath(record.session.id, paths), next, paths);
	return { record: next, stopped };
}

export interface StatusView {
	state: string;
	registrationId: string;
	sessionId: string;
	sessionFile: string;
	job: {
		id: string;
		unit: string;
		active: boolean;
		startedAt: string;
		estimatedWaitMs: number;
		timeoutMs: number;
		resultDir: string;
	};
	wake: {
		policy: ResumePolicy;
		pending: Array<{ id: string; kind: string; createdAt: string }>;
		consumed: Array<{ id: string; kind: string; consumedAt?: string; outcome?: string }>;
	};
	watcher: {
		mode: string;
		socket: string;
		epoch?: number;
		coordinatorAcked: boolean;
		lastError?: string;
	};
	result?: { exitCode: number; durationMs: number; artifacts: number };
	updatedAt: string;
	diagnostics: HibernationRecord["diagnostics"];
}

export function statusView(record: HibernationRecord): StatusView {
	const probe = probeUnit(record.job.unit);
	const result = readJobResult(record.job.resultDir);
	return {
		state: record.state,
		registrationId: record.registrationId,
		sessionId: record.session.id,
		sessionFile: record.session.file,
		job: {
			id: record.job.id,
			unit: record.job.unit,
			active: probe.active,
			startedAt: record.job.startedAt,
			estimatedWaitMs: record.wake.estimatedWaitMs,
			timeoutMs: record.wake.condition.maxWaitMs,
			resultDir: record.job.resultDir,
		},
		wake: {
			policy: record.wake.policy,
			pending: record.wake.events
				.filter(event => !event.consumedAt)
				.map(event => ({ id: event.id, kind: event.kind, createdAt: event.createdAt })),
			consumed: record.wake.events
				.filter(event => event.consumedAt !== undefined)
				.map(event => ({
					id: event.id,
					kind: event.kind,
					consumedAt: event.consumedAt,
					outcome: event.outcome,
				})),
		},
		watcher: {
			mode: record.watcher.mode,
			socket: record.watcher.socket,
			epoch: record.watcher.epoch,
			coordinatorAcked: record.watcher.coordinatorAcked,
			lastError: record.watcher.lastError,
		},
		...(result !== undefined && {
			result: { exitCode: result.exitCode, durationMs: result.durationMs, artifacts: result.artifacts.length },
		}),
		updatedAt: record.updatedAt,
		diagnostics: record.diagnostics,
	};
}

/**
 * Mark abandoned in-flight records for manual recovery. Returns what changed.
 * It never launches an agent: recovery is an explicit operator action.
 */
export function recoverHibernations(options: { apply?: boolean; paths?: HibernationPaths } = {}): Array<{
	record: HibernationRecord;
	action: string;
}> {
	const paths = options.paths ?? hibernationPaths();
	const results: Array<{ record: HibernationRecord; action: string }> = [];
	for (const record of listRecords(paths)) {
		if (record.state === "RESUMING") {
			const pending = record.wake.events.find(event => !event.consumedAt);
			const holder = pending?.claimedBy;
			const alive = holder ? probeProcessIdentity(holder).alive : false;
			if (!alive) {
				let next = transition(record, "RECOVERY_REQUIRED", "resume claim has no live holder");
				next = diagnose(next, "warning", "recovered abandoned resume claim");
				if (options.apply) saveRecord(recordPath(record.session.id, paths), next, paths);
				results.push({ record: next, action: "marked RECOVERY_REQUIRED" });
			}
			continue;
		}
		if (record.state === "PREPARING") {
			const owner = probeProcessIdentity(record.owner);
			if (owner.alive) continue;
			let next = transition(record, "RECOVERY_REQUIRED", `preparing owner is gone (${owner.reason})`);
			next = diagnose(next, "warning", "hibernation registration was interrupted; the job may still be running");
			if (options.apply) saveRecord(recordPath(record.session.id, paths), next, paths);
			results.push({ record: next, action: "marked RECOVERY_REQUIRED" });
			continue;
		}
		if (record.state === "HIBERNATED" || record.state === "WAKE_PENDING") {
			const observation = observeJob(record);
			results.push({
				record,
				action:
					observation.kind === "completed"
						? "job completed; run `omp hibernate wake`"
						: observation.kind === "failed" || observation.kind === "vanished"
							? `job ${observation.kind}; inspect before waking`
							: "still waiting",
			});
		}
	}
	return results;
}

/** Best-effort watcher acknowledgement of a consumed event. */
export async function acknowledgeWatcher(
	record: HibernationRecord,
	eventId: string,
	outcome: string,
	detail?: string,
	settings?: Settings,
): Promise<void> {
	if (record.watcher.mode === "local-only") return;
	const client = new WatcherClient({
		socket: (settings ? cfgHibernationSocket.get(settings) : undefined) || record.watcher.socket || undefined,
		tokenFile: settings ? cfgHibernationTokenFile.get(settings) || undefined : undefined,
	});
	try {
		await client.ack(record.registrationId, eventId, outcome, detail);
	} catch (error) {
		logger.warn("Could not acknowledge wake to the watcher", {
			registrationId: record.registrationId,
			eventId,
			error: toError(error).message,
		});
	}
}

export function stallSeconds(settings: Settings): number {
	return cfgHibernationStallSeconds.get(settings);
}

export { observeJob, probeUnit, readJobResult, verifyArtifacts };
