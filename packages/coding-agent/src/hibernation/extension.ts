/**
 * Native hibernation extension.
 *
 * Loaded unconditionally by the session factory (like the autoresearch
 * extension) and active only when `hibernation.enabled` is set. It contributes:
 *
 *   - the agent-callable `hibernate` tool,
 *   - `/hibernate` and `/hibernation-status` operator commands,
 *   - a session-start notice for a resumed hibernation.
 *
 * The tool is the only agent-facing surface. The external watcher and the
 * `omp hibernate` CLI own the rest; no model call is needed to inspect state.
 */

import { logger, toError } from "@oh-my-pi/pi-utils";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../extensibility/extensions/types";
import type { Settings } from "../config/settings";
import {
	cancelHibernation,
	registerHibernation,
	recoverHibernations,
	statusView,
	type StatusView,
} from "./service";
import {
	cfgHibernationEnabled,
	cfgHibernationMaxWaitSeconds,
	cfgHibernationResumePolicy,
	cfgHibernationWatcherMode,
} from "./settings";
import { findRecord, listRecords } from "./store";
import type { HibernationRecord } from "./types";
import { WatcherClient } from "./watcher";

const HIBERNATION_ENTRY_TYPE = "hibernation.record";

interface HibernateToolParams {
	jobId: string;
	command: string;
	cwd?: string;
	timeoutSeconds?: number;
	estimatedWaitSeconds: number;
	requiredArtifacts?: string[];
	successExitCodes?: number[];
	intent: {
		objective: string;
		hypothesis?: string;
		successCriteria?: string;
		lastAction?: string;
		nextActions?: string[];
	};
	resumePolicy?: "auto" | "manual";
	force?: boolean;
	allowDegraded?: boolean;
}

function formatStatus(record: StatusView): string {
	const lines = [
		`state=${record.state} registration=${record.registrationId}`,
		`session=${record.sessionId}`,
		`job=${record.job.id} unit=${record.job.unit} active=${record.job.active}`,
		`wait estimate=${Math.round(record.job.estimatedWaitMs / 1000)}s timeout=${Math.round(record.job.timeoutMs / 1000)}s`,
		`wake policy=${record.wake.policy} pending=${record.wake.pending.map(event => event.id).join(",") || "none"}`,
		`watcher mode=${record.watcher.mode} coordinator=${record.watcher.coordinatorAcked} epoch=${record.watcher.epoch ?? "-"}`,
	];
	if (record.result) {
		lines.push(
			`result exit=${record.result.exitCode} duration=${Math.round(record.result.durationMs / 1000)}s artifacts=${record.result.artifacts}`,
		);
	}
	if (record.diagnostics.length > 0) {
		lines.push(`last diagnostic: ${record.diagnostics.at(-1)?.message ?? ""}`);
	}
	return lines.join("\n");
}

function formatRecordLine(record: HibernationRecord): string {
	return `${record.state.padEnd(17)} ${record.session.id.slice(0, 8)}  ${record.job.id}  ${record.job.unit}  ${record.updatedAt}`;
}

/** The current OMP executable, for spawning a nested CLI command. */
export function ompInvocation(): string[] {
	if (process.env.PI_COMPILED === "true") return [process.execPath];
	return [process.execPath, Bun.main];
}

async function runOmpDetached(args: string[], cwd: string): Promise<number | undefined> {
	const child = Bun.spawn([...ompInvocation(), ...args], {
		cwd,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: process.env,
	});
	child.unref();
	return child.pid;
}

export function createHibernationExtension(settings: Settings) {
	return function hibernationExtension(pi: ExtensionAPI): void {
		const z = pi.zod;

		pi.registerTool({
			name: "hibernate",
			label: "Hibernate",
			loadMode: "essential",
			description:
				"Suspend this entire OMP session while an independent experiment runs, then resume the same session " +
				"when the external watcher sees the result. Use only when (a) the next decision depends on the job, " +
				"(b) the expected wait is long (minutes to hours), and (c) no owned background job or queued user " +
				"message would be lost. The experiment is launched as a systemd --user unit, so it survives OMP " +
				"exiting or crashing. The tool registers a durable wake condition with the watcher and, after an " +
				"acknowledgement, exits this OMP process. It does NOT sleep or poll. If registration fails, the " +
				"session stays active and the job keeps running.",
			parameters: z.object({
				jobId: z.string().describe("Stable experiment id (letters, digits, dash, underscore), e.g. 'gpu-bench-7'"),
				command: z.string().describe("Shell command to run independently; executed locally under systemd"),
				cwd: z.string().optional().describe("Working directory (default: the session cwd)"),
				timeoutSeconds: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Hard wall-clock limit for the experiment (default: hibernation.maxWaitSeconds)"),
				estimatedWaitSeconds: z
					.number()
					.int()
					.positive()
					.describe("Honest estimate of how long the job will take; used to refuse pointless hibernation"),
				requiredArtifacts: z
					.array(z.string())
					.optional()
					.describe("Files that must exist, be non-empty, and match their recorded hashes before the wake counts as success"),
				successExitCodes: z.array(z.number().int()).optional().describe("Exit codes that count as success (default [0])"),
				intent: z.object({
					objective: z.string().describe("Why this session exists; the resumed agent must continue this objective"),
					hypothesis: z.string().optional().describe("The hypothesis the experiment tests"),
					successCriteria: z.string().optional().describe("What result would confirm or refute it"),
					lastAction: z.string().optional().describe("Last committed action, so the resume does not repeat it"),
					nextActions: z.array(z.string()).optional().describe("What to do once the result arrives"),
				}),
				resumePolicy: z
					.enum(["auto", "manual"])
					.optional()
					.describe("Override hibernation.resumePolicy for this registration"),
				force: z.boolean().optional().describe("Bypass the minimum-wait/background-job policy; operator intent"),
				allowDegraded: z
					.boolean()
					.optional()
					.describe("Hibernate with local watcher supervision even if the external coordinator did not acknowledge"),
			}),
			async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
				const params = rawParams as HibernateToolParams;
				if (!cfgHibernationEnabled.get(settings)) {
					return {
						content: [
							{
								type: "text",
								text: "Hibernation is disabled (hibernation.enabled=false). Ask the operator to enable it before using this tool.",
							},
						],
						isError: true,
					};
				}
				try {
					const snapshot = ctx.getAsyncJobSnapshot();
					const pendingAsyncJobs = snapshot ? snapshot.running.length : 0;
					const result = await registerHibernation({
						sessionManager: ctx.sessionManager,
						jobId: params.jobId,
						command: params.command,
						...(params.cwd !== undefined && { cwd: params.cwd }),
						...(params.timeoutSeconds !== undefined && { timeoutSeconds: params.timeoutSeconds }),
						estimatedWaitSeconds: params.estimatedWaitSeconds,
						requiredArtifacts: params.requiredArtifacts ?? [],
						successExitCodes: params.successExitCodes ?? [0],
						intent: params.intent,
						settings,
						force: params.force ?? false,
						allowDegraded: params.allowDegraded ?? false,
						...(params.resumePolicy !== undefined && { resumePolicy: params.resumePolicy }),
						pendingAsyncJobs,
						hasQueuedMessages: ctx.hasPendingMessages(),
					});
					pi.appendEntry(HIBERNATION_ENTRY_TYPE, {
						registrationId: result.record.registrationId,
						state: result.record.state,
						jobId: result.record.job.id,
						unit: result.record.job.unit,
						resultDir: result.record.job.resultDir,
						wakePolicy: result.record.wake.policy,
						watcher: result.record.watcher,
						at: new Date().toISOString(),
					});
					const lines = [
						`Hibernation ${result.record.registrationId} accepted.`,
						`Experiment: ${result.record.job.id} (${result.record.job.unit})`,
						`Result directory: ${result.record.job.resultDir}`,
						`Wake: ${result.record.wake.policy}${result.ack.coordinatorAcked ? ", external coordinator acknowledged" : ", local supervision only"}`,
						`Watcher epoch: ${result.ack.epoch ?? "unknown"}`,
					];
					if (result.ack.alreadyComplete) {
						lines.push(
							"The job already finished; the watcher will resume this session immediately after exit.",
						);
					}
					lines.push(
						"The session is now being released. Do not start more tool work in this turn; the exact session will resume when the result is ready.",
					);
					ctx.shutdown();
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: {
							terminal: true,
							registrationId: result.record.registrationId,
							state: result.record.state,
							jobId: result.record.job.id,
							unit: result.record.job.unit,
							resultDir: result.record.job.resultDir,
							coordinatorAcked: result.ack.coordinatorAcked,
						},
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Hibernation failed: ${toError(error).message}` }],
						isError: true,
					};
				}
			},
		});

		const statusHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const trimmed = args.trim();
			const [subcommand = "status", ...rest] = trimmed.split(/\s+/).filter(Boolean);
			if (subcommand === "list") {
				const records = listRecords();
				ctx.ui.notify(
					records.length === 0 ? "No hibernation records." : records.map(formatRecordLine).join("\n"),
					"info",
				);
				return;
			}
			if (subcommand === "wake") {
				const sessionRef = rest[0];
				if (!sessionRef) {
					ctx.ui.notify("Usage: /hibernate wake <session-id|session-path> [--event <id>]", "warning");
					return;
				}
				const record = findRecord(sessionRef);
				if (!record) {
					ctx.ui.notify(`No hibernation record for ${sessionRef}`, "error");
					return;
				}
				const pid = await runOmpDetached(
					["hibernate", "wake", "--session", record.session.file, ...(rest.slice(1) ?? [])],
					record.session.cwd,
				);
				ctx.ui.notify(`Wake launched for ${record.registrationId} (pid ${pid ?? "?"}); the exact session will resume.`, "info");
				return;
			}
			if (subcommand === "cancel") {
				const sessionRef = rest[0] ?? ctx.sessionManager.getSessionFile();
				if (!sessionRef) {
					ctx.ui.notify("Usage: /hibernate cancel <session-id|path> [--stop]", "warning");
					return;
				}
				try {
					const cancelled = cancelHibernation(sessionRef, {
						stopJob: rest.includes("--stop"),
						reason: "operator cancelled from /hibernate",
					});
					if (cancelled.record.watcher.mode !== "local-only") {
						const client = new WatcherClient({ socket: cancelled.record.watcher.socket });
						await client
							.cancel(cancelled.record.registrationId, { stopJob: cancelled.stopped })
							.catch(error => logger.warn("Watcher cancel failed", { error: toError(error).message }));
					}
					ctx.ui.notify(
						`Cancelled ${cancelled.record.registrationId}${cancelled.stopped ? " and stopped the job" : ""}.`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(`Cancel failed: ${toError(error).message}`, "error");
				}
				return;
			}
			if (subcommand === "recover") {
				const findings = recoverHibernations({ apply: rest.includes("--apply") });
				ctx.ui.notify(
					findings.length === 0
						? "No records need recovery."
						: findings.map(finding => `${finding.record.registrationId}: ${finding.action}`).join("\n"),
					"info",
				);
				return;
			}
			const record = findRecord(ctx.sessionManager.getSessionFile() ?? "");
			if (!record) {
				ctx.ui.notify("This session has no hibernation record.", "info");
				return;
			}
			const view = statusView(record);
			ctx.ui.notify(formatStatus(view), "info");
		};

		pi.registerCommand("hibernate", {
			description: "Inspect, wake, cancel, or recover hibernated sessions (status|list|wake|cancel|recover)",
			handler: statusHandler,
		});
		pi.registerCommand("hibernation-status", {
			description: "Show this session's hibernation state",
			handler: async (_args, ctx) => {
				const record = findRecord(ctx.sessionManager.getSessionFile() ?? "");
				ctx.ui.notify(record ? formatStatus(statusView(record)) : "This session has no hibernation record.", "info");
			},
		});

		pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			const file = ctx.sessionManager.getSessionFile();
			if (!file) return;
			const record = findRecord(file);
			if (!record) return;
			const pending = record.wake.events.filter(event => !event.consumedAt);
			if (pending.length === 0) return;
			ctx.ui.notify(
				`Resumed hibernation ${record.registrationId}: ${pending.length} pending wake event(s).`,
				"info",
			);
		});

		pi.on("session_shutdown", async () => {
			// Nothing to release: the record and job are independent by design.
		});
	};
}

export function hibernationHints(settings: Settings): string[] {
	const hints: string[] = [];
	if (!cfgHibernationEnabled.get(settings)) return hints;
	const mode = cfgHibernationWatcherMode.get(settings);
	const policy = cfgHibernationResumePolicy.get(settings);
	hints.push(
		`hibernation: enabled (watcher=${mode}, wake=${policy}, max wait=${cfgHibernationMaxWaitSeconds.get(settings)}s)`,
	);
	return hints;
}

export { HIBERNATION_ENTRY_TYPE };
