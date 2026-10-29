/**
 * Hibernation settings.
 *
 * Disabled by default: a hibernation is only useful when an external watcher
 * owns execution lifecycle, and silently exiting a session is not a safe
 * default. Enable it per user config:
 *
 *   hibernation:
 *     enabled: true
 */

import { register } from "../config/registry";
import type { ResumePolicy } from "./types";

export const cfgHibernationEnabled = register({
	id: "hibernation.enabled",
	type: "boolean",
	default: false,
	env: "OMP_HIBERNATION_ENABLED",
	ui: {
		tab: "tools",
		group: "Hibernation",
		label: "Durable Hibernation",
		description:
			"Allow OMP to register a durable hibernation with the external watcher, exit, and resume the same session when the job result is ready",
	},
});

export const cfgHibernationWatcherMode = register({
	id: "hibernation.watcherMode",
	type: "enum",
	values: ["required", "local-only"] as const,
	default: "required" as const,
	ui: {
		tab: "tools",
		group: "Hibernation",
		label: "Watcher Requirement",
		description:
			"required: exit only after the watcher acknowledges durable monitoring. local-only: write a local record and require a manual `omp hibernate wake`",
		options: [
			{
				value: "required",
				label: "Required (Recommended)",
				description: "Refuse to hibernate if the external watcher cannot accept the registration",
			},
			{
				value: "local-only",
				label: "Local record only",
				description: "No external watcher; a suspended session can only be woken manually",
			},
		],
	},
});

export const cfgHibernationSocket = register({
	id: "hibernation.socket",
	type: "string",
	default: "",
	env: "OMP_HIBERNATION_SOCKET",
	ui: {
		tab: "tools",
		group: "Hibernation",
		label: "Watcher Socket",
		description: "Unix socket of the ai-watcher node (default: $XDG_RUNTIME_DIR/ai-watcher-node.sock)",
	},
});

export const cfgHibernationTokenFile = register({
	id: "hibernation.tokenFile",
	type: "string",
	default: "",
	env: "OMP_HIBERNATION_TOKEN_FILE",
	credential: true,
	ui: {
		tab: "tools",
		group: "Hibernation",
		label: "Watcher Token File",
		description: "File holding the local socket capability token (default: <agent-dir>/hibernation/watcher.token)",
		secret: true,
	},
});

export const cfgHibernationMinWaitSeconds = register({
	id: "hibernation.minWaitSeconds",
	type: "number",
	default: 300,
	normalize: value => Math.max(0, Math.floor(Number(value))),
	ui: {
		tab: "tools",
		group: "Hibernation",
		label: "Minimum Estimated Wait (seconds)",
		description: "Below this expected wait, hibernation costs more than it saves; the tool refuses unless forced",
		options: [
			{ value: "60", label: "1 minute" },
			{ value: "300", label: "5 minutes (default)" },
			{ value: "600", label: "10 minutes" },
			{ value: "1800", label: "30 minutes" },
		],
	},
});

export const cfgHibernationMaxWaitSeconds = register({
	id: "hibernation.maxWaitSeconds",
	type: "number",
	default: 86_400,
	normalize: value => Math.max(60, Math.floor(Number(value))),
	ui: {
		tab: "tools",
		group: "Hibernation",
		label: "Maximum Wait (seconds)",
		description: "Upper bound for one hibernation; the watcher reports TIMED_OUT after this",
		options: [
			{ value: "3600", label: "1 hour" },
			{ value: "21600", label: "6 hours" },
			{ value: "86400", label: "24 hours (default)" },
			{ value: "604800", label: "7 days" },
		],
	},
});

export const cfgHibernationResumePolicy = register({
	id: "hibernation.resumePolicy",
	type: "enum",
	values: ["auto", "manual"] as const,
	default: "auto" as const,
	ui: {
		tab: "tools",
		group: "Hibernation",
		label: "Wake Policy",
		description:
			"auto: the watcher resumes the exact session when the wake condition is met. manual: record the event and wait for `omp hibernate wake`",
		options: [
			{ value: "auto", label: "Automatic (Recommended)", description: "Resume without operator intervention" },
			{ value: "manual", label: "Manual", description: "Only a human or explicit CLI command resumes" },
		],
	},
});

export const cfgHibernationStallSeconds = register({
	id: "hibernation.stallSeconds",
	type: "number",
	default: 900,
	normalize: value => Math.max(60, Math.floor(Number(value))),
	ui: {
		tab: "tools",
		group: "Hibernation",
		label: "Stall Threshold (seconds)",
		description: "Report a running job as stalled when its result directory stops changing for this long",
		options: [
			{ value: "300", label: "5 minutes" },
			{ value: "900", label: "15 minutes (default)" },
			{ value: "3600", label: "1 hour" },
		],
	},
});

export function resolveResumePolicy(value: string | undefined): ResumePolicy {
	return value === "manual" ? "manual" : "auto";
}
