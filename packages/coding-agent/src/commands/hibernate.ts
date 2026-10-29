/**
 * `omp hibernate` — inspect, wake, cancel, and recover suspended sessions
 * without invoking a model.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { hibernateHelp as commandHelp } from "../cli/command-help";
import { type HibernateAction, runHibernateCommand } from "../cli/hibernate-cli";

const ACTIONS: HibernateAction[] = ["status", "list", "wake", "cancel", "recover", "jobs"];

export default class Hibernate extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "status, list, wake, cancel, recover, or jobs",
			required: false,
			options: ACTIONS,
		}),
	};

	static flags = {
		session: Flags.string({ description: "Session id or session JSONL path" }),
		event: Flags.string({ description: "Wake event id (wake; defaults to the newest pending event)" }),
		json: Flags.boolean({ description: "Emit machine-readable JSON" }),
		force: Flags.boolean({ description: "Wake even when the recorded owner appears alive, or bypass policy" }),
		stop: Flags.boolean({ description: "Also stop the job's systemd unit (cancel)" }),
		reason: Flags.string({ description: "Cancellation reason recorded in the journal" }),
		apply: Flags.boolean({ description: "Write recovery states instead of a dry run (recover)" }),
		interactive: Flags.boolean({ description: "Wake into the interactive TUI instead of print mode" }),
		all: Flags.boolean({ description: "Include terminal records (list)" }),
	};

	static examples = [
		"omp hibernate list",
		"omp hibernate status --session <id|path>",
		"omp hibernate status --session <id|path> --json",
		"omp hibernate wake --session <id|path>",
		"omp hibernate cancel --session <id|path> --stop",
		"omp hibernate recover --apply",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Hibernate);
		const exitCode = await runHibernateCommand({
			action: (args.action ?? "status") as HibernateAction,
			flags: {
				session: flags.session,
				event: flags.event,
				json: flags.json ?? false,
				force: flags.force ?? false,
				stop: flags.stop ?? false,
				reason: flags.reason,
				apply: flags.apply ?? false,
				interactive: flags.interactive ?? false,
				all: flags.all ?? false,
			},
		});
		if (exitCode !== 0) process.exitCode = exitCode;
		// One-shot operator command: SQLite/auth handles opened by Settings.init
		// must not keep the process alive after the command has reported.
		process.exit(exitCode);
	}
}
