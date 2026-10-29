/**
 * `omp hibernate` — operator interface for suspended sessions.
 *
 * All inspection paths are local file/process reads; none invokes a model.
 * `wake` is the only path that starts an agent, and it runs the same OMP
 * binary with `--resume <exact session>` plus a structured prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger, toError } from "@oh-my-pi/pi-utils";
import {
	completeWake,
	cancelHibernation,
	ompInvocation,
	prepareWake,
	recoverHibernations,
	statusView,
	syncWakeEvents,
	acknowledgeWatcher,
	WakeAlreadyConsumedError,
	type StatusView,
} from "../hibernation";
import { findRecord, hibernationPaths, listRecords, sessionFileSize } from "../hibernation/store";
import {
	cfgHibernationSocket,
	cfgHibernationTokenFile,
} from "../hibernation/settings";
import { WatcherClient } from "../hibernation/watcher";
import { appendWakeEvent } from "../hibernation/store";
import type { HibernationRecord } from "../hibernation/types";
import { Settings } from "../config/settings";

export type HibernateAction = "status" | "list" | "wake" | "cancel" | "recover" | "jobs";

export interface HibernateCommandArgs {
	action: HibernateAction;
	flags: {
		session?: string;
		event?: string;
		json?: boolean;
		force?: boolean;
		stop?: boolean;
		reason?: string;
		apply?: boolean;
		interactive?: boolean;
		all?: boolean;
	};
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function planCwd(sessionRef: string): string {
	try {
		const record = findRecord(sessionRef);
		if (record) return record.session.cwd;
	} catch {}
	return process.cwd();
}

function formatStatus(view: StatusView): string {
	const lines = [
		`state:        ${view.state}`,
		`registration: ${view.registrationId}`,
		`session:      ${view.sessionId}`,
		`file:         ${view.sessionFile}`,
		`job:          ${view.job.id}  unit=${view.job.unit}  active=${view.job.active}`,
		`wait:         estimate ${Math.round(view.job.estimatedWaitMs / 1000)}s / timeout ${Math.round(
			view.job.timeoutMs / 1000,
		)}s`,
		`wake:         policy=${view.wake.policy} pending=${
			view.wake.pending.map(event => `${event.id}(${event.kind})`).join(", ") || "none"
		}`,
		`watcher:      mode=${view.watcher.mode} coordinator=${view.watcher.coordinatorAcked} epoch=${
			view.watcher.epoch ?? "-"
		}`,
		`updated:      ${view.updatedAt}`,
	];
	if (view.result) {
		lines.push(
			`result:       exit=${view.result.exitCode} duration=${Math.round(view.result.durationMs / 1000)}s artifacts=${view.result.artifacts}`,
		);
	}
	if (view.watcher.lastError) lines.push(`watcher err:  ${view.watcher.lastError}`);
	for (const diagnostic of view.diagnostics.slice(-3)) {
		lines.push(`[${diagnostic.level}] ${diagnostic.at} ${diagnostic.message}${diagnostic.detail ? `: ${diagnostic.detail}` : ""}`);
	}
	return lines.join("\n");
}

function formatRow(record: HibernationRecord): string {
	return `${record.state.padEnd(17)} ${record.registrationId}  ${record.job.id}  ${record.job.unit}  ${record.updatedAt}`;
}

/** Whether the session gained a message at or after `since`. */
function sessionHasTurnAfter(file: string, since: string): boolean {
	try {
		const stat = fs.statSync(file);
		const start = Math.max(0, stat.size - 4 * 1024 * 1024);
		const fd = fs.openSync(file, "r");
		try {
			const buffer = Buffer.alloc(stat.size - start);
			fs.readSync(fd, buffer, 0, buffer.length, start);
			const threshold = Date.parse(since);
			for (const line of buffer.toString("utf8").split("\n")) {
				if (!line.includes('"type":"message"')) continue;
				try {
					const parsed: unknown = JSON.parse(line);
					if (typeof parsed !== "object" || parsed === null) continue;
					if (!("timestamp" in parsed) || typeof parsed.timestamp !== "string") continue;
					const at = Date.parse(parsed.timestamp);
					if (Number.isFinite(at) && at >= threshold) return true;
				} catch {}
			}
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
	return false;
}

async function wake(args: HibernateCommandArgs): Promise<number> {
	const sessionRef = args.flags.session;
	if (!sessionRef) {
		process.stderr.write("omp hibernate wake: --session is required\n");
		return 2;
	}
	let plan: ReturnType<typeof prepareWake>;
	const settings = await Settings.init({ cwd: planCwd(sessionRef) });
	try {
		const known = findRecord(sessionRef);
		if (known && known.watcher.mode !== "local-only") {
			const synced = await syncWakeEvents(known, settings);
			if (synced.error) {
				logger.warn("Could not sync wake events from the watcher; using the local record", {
					error: synced.error,
				});
			}
		}
		plan = prepareWake({
			sessionRef,
			eventId: args.flags.event,
			force: args.flags.force ?? false,
			allowReclaim: args.flags.force ?? false,
			manualReason: args.flags.force ? "operator forced a manual wake" : undefined,
		});
	} catch (error) {
		if (error instanceof WakeAlreadyConsumedError) {
			process.stdout.write(`already consumed: ${error.message}\n`);
			return 0;
		}
		process.stderr.write(`omp hibernate wake: ${toError(error).message}\n`);
		return 1;
	}

	const startedAt = new Date().toISOString();
	const logFile = path.join(
		hibernationPaths().logs,
		`wake-${plan.event.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
	);
	fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
	const argv = [
		"--resume",
		plan.record.session.file,
		"--cwd",
		plan.record.session.cwd,
		"--length-is-terminal",
		...(args.flags.interactive ? [plan.prompt] : ["-p", plan.prompt, "--auto-approve"]),
	];
	process.stdout.write(
		`waking ${plan.record.registrationId} (event ${plan.event.id}) in ${plan.record.session.cwd}\n`,
	);
	const logFd = fs.openSync(logFile, "a", 0o600);
	try {
		const child = Bun.spawn([...ompInvocation(), ...argv], {
			cwd: plan.record.session.cwd,
			stdin: "ignore",
			stdout: logFd,
			stderr: logFd,
			env: process.env,
		});
		const timeoutMs = 3_600_000;
		const exited = await Promise.race([
			child.exited.then(code => ({ kind: "exit" as const, code })),
			Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
		]);
		if (exited.kind === "timeout") {
			child.kill("SIGTERM");
			await Promise.race([child.exited, Bun.sleep(10_000)]);
			child.kill("SIGKILL");
			const after = sessionFileSize(plan.record.session.file);
			completeWake(plan, {
				ok: false,
				detail: `resume turn exceeded ${Math.round(timeoutMs / 1000)}s; see ${logFile}`,
				sessionSizeAfter: after,
			});
			await acknowledgeWatcher(
				plan.record,
				plan.event.id,
				"error",
				`resume turn timed out; log ${logFile}`,
				settings,
			);
			process.stderr.write(`omp hibernate wake timed out; log: ${logFile}\n`);
			return 1;
		}
		const after = sessionFileSize(plan.record.session.file);
		const turned = sessionHasTurnAfter(plan.record.session.file, startedAt);
		const grew = after !== plan.sessionSizeBefore || turned;
		const completed = completeWake(plan, {
			ok: grew,
			detail: grew
				? `resumed at ${startedAt} (exit ${exited.code}); log ${logFile}`
				: `the resumed turn produced no session message (exit ${exited.code}); log ${logFile}`,
			sessionSizeAfter: after,
		});
		await acknowledgeWatcher(
			completed,
			plan.event.id,
			grew ? "resumed" : "error",
			grew ? `exit ${exited.code}` : `no session message; log ${logFile}`,
			settings,
		);
		if (!grew) {
			process.stderr.write(`wake ran but the session did not record a turn; log: ${logFile}\n`);
			return 1;
		}
		process.stdout.write(`resumed ${completed.session.id} (event ${plan.event.id}), exit ${exited.code}\n`);
		return exited.code === 0 ? 0 : 1;
	} catch (error) {
		const message = toError(error).message;
		completeWake(plan, {
			ok: false,
			detail: `${message}; log ${logFile}`,
			sessionSizeAfter: sessionFileSize(plan.record.session.file),
		});
		await acknowledgeWatcher(plan.record, plan.event.id, "error", message, settings);
		process.stderr.write(`omp hibernate wake failed: ${message}; log: ${logFile}\n`);
		return 1;
	} finally {
		fs.closeSync(logFd);
	}
}

async function notifyWatcherCancel(record: HibernationRecord, stopped: boolean): Promise<void> {
	if (record.watcher.mode === "local-only") return;
	const client = new WatcherClient({ socket: record.watcher.socket });
	try {
		await client.cancel(record.registrationId, { stopJob: stopped, reason: "operator cancelled" });
	} catch (error) {
		logger.warn("Could not notify watcher of cancellation", { error: toError(error).message });
	}
}

export async function runHibernateCommand(command: HibernateCommandArgs): Promise<number> {
	const paths = hibernationPaths();
	const action = command.action;
	if (action === "list" || (action === "jobs" && !command.flags.session)) {
		const records = listRecords(paths);
		if (command.flags.json) {
			printJson(records.map(record => statusView(record)));
			return 0;
		}
		if (records.length === 0) {
			process.stdout.write("No hibernation records.\n");
			return 0;
		}
		for (const record of records) process.stdout.write(`${formatRow(record)}\n`);
		return 0;
	}
	if (action === "status") {
		const records = command.flags.session
			? [findRecord(command.flags.session, paths)].filter((record): record is HibernationRecord => !!record)
			: listRecords(paths);
		if (records.length === 0) {
			process.stderr.write(
				command.flags.session ? `No hibernation record for ${command.flags.session}\n` : "No hibernation records.\n",
			);
			return command.flags.session ? 1 : 0;
		}
		const views = records.map(statusView);
		if (command.flags.json) printJson(views.length === 1 ? views[0] : views);
		else process.stdout.write(`${views.map(formatStatus).join("\n\n")}\n`);
		return 0;
	}
	if (action === "wake") return await wake(command);
	if (action === "cancel") {
		if (!command.flags.session) {
			process.stderr.write("omp hibernate cancel: --session is required\n");
			return 2;
		}
		try {
			const result = cancelHibernation(command.flags.session, {
				stopJob: command.flags.stop ?? false,
				reason: command.flags.reason ?? "operator cancelled from CLI",
				paths,
			});
			await notifyWatcherCancel(result.record, result.stopped);
			if (command.flags.json) printJson(statusView(result.record));
			else
				process.stdout.write(
					`cancelled ${result.record.registrationId}${result.stopped ? " and stopped the job" : ""}\n`,
				);
			return 0;
		} catch (error) {
			process.stderr.write(`omp hibernate cancel: ${toError(error).message}\n`);
			return 1;
		}
	}
	if (action === "recover") {
		const findings = recoverHibernations({ apply: command.flags.apply ?? false, paths });
		if (command.flags.json) {
			printJson(
				findings.map(finding => ({
					registrationId: finding.record.registrationId,
					state: finding.record.state,
					session: finding.record.session.file,
					action: finding.action,
				})),
			);
			return 0;
		}
		if (findings.length === 0) {
			process.stdout.write("Nothing to recover.\n");
			return 0;
		}
		for (const finding of findings) {
			process.stdout.write(`${finding.record.registrationId}  ${finding.record.state}  ${finding.action}\n`);
		}
		if (!command.flags.apply) process.stdout.write("Dry run; pass --apply to write recovery states.\n");
		return 0;
	}
	process.stderr.write(`Unknown hibernate action: ${action}\n`);
	return 2;
}

export async function watcherEndpoint(): Promise<{ socket: string; tokenFile: string }> {
	const settings = await Settings.init({ cwd: process.cwd() });
	return {
		socket: cfgHibernationSocket.get(settings) || "",
		tokenFile: cfgHibernationTokenFile.get(settings) || "",
	};
}
