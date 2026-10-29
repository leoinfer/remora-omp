/**
 * Client for the external watcher's local node socket.
 *
 * The watcher owns execution lifecycle. OMP owns reasoning lifecycle. This
 * client only registers a durable hibernation, asks for status, cancels a
 * registration, and acknowledges a resumed wake. It never asks the watcher to
 * run an arbitrary command: the job was launched locally by OMP, and the wake
 * command is an allowlisted `omp hibernate wake`.
 *
 * Wire format: one JSON object per line over a 0600 Unix socket. The node
 * checks SO_PEERCRED and the capability token in `watcher.token`.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import type { HibernationRecord } from "./types";

export const WATCHER_PROTOCOL_VERSION = 1;

export interface WatcherRequest {
	v: number;
	op: string;
	token?: string;
	[key: string]: unknown;
}

export interface RegisterAck {
	accepted: boolean;
	registrationId: string;
	epoch?: number;
	state: string;
	coordinator: {
		acked: boolean;
		detail?: string;
	};
	alreadyComplete?: boolean;
	unitActive?: boolean;
}

export interface WatcherJobStatus {
	registrationId: string;
	state: string;
	job: {
		unit: string;
		active: boolean;
		subState?: string;
		result?: string;
		exitCode?: number;
		elapsedMs?: number;
		stalled?: boolean;
	};
	wake: {
		pendingEvents: Array<{ id: string; kind: string; createdAt: string }>;
	};
	lastError?: string;
	updatedAt?: string;
}

export class WatcherError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "WatcherError";
	}
}

function defaultSocketPath(): string {
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (runtime) return path.join(runtime, "ai-watcher-node.sock");
	return path.join(getAgentDir(), "hibernation", "watcher.sock");
}

export interface WatcherClientOptions {
	socket?: string;
	tokenFile?: string;
	timeoutMs?: number;
}

export class WatcherClient {
	readonly socket: string;
	readonly tokenFile: string;
	readonly timeoutMs: number;

	constructor(options: WatcherClientOptions = {}) {
		this.socket = options.socket ?? process.env.OMP_HIBERNATION_SOCKET ?? defaultSocketPath();
		this.tokenFile =
			options.tokenFile ??
			process.env.OMP_HIBERNATION_TOKEN_FILE ??
			path.join(getAgentDir(), "hibernation", "watcher.token");
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	#token(): string | undefined {
		try {
			return fs.readFileSync(this.tokenFile, "utf8").trim() || undefined;
		} catch {
			return undefined;
		}
	}

	async request(op: string, payload: Record<string, unknown> = {}, retries = 0): Promise<unknown> {
		let lastError: WatcherError | undefined;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				return await this.#requestOnce({ v: WATCHER_PROTOCOL_VERSION, op, token: this.#token(), ...payload });
			} catch (error) {
				const watcherError =
					error instanceof WatcherError
						? error
						: new WatcherError(toError(error).message, "transport", true);
				lastError = watcherError;
				if (!watcherError.retryable || attempt >= retries) break;
				await Bun.sleep(250 * 2 ** attempt);
			}
		}
		throw lastError ?? new WatcherError("watcher request failed", "unknown", false);
	}

	async #requestOnce(request: WatcherRequest): Promise<unknown> {
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const socket = net.createConnection({ path: this.socket });
		let buffer = "";
		const finish = (error: WatcherError | undefined, value?: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		};
		timer = setTimeout(() => {
			finish(
				new WatcherError(
					`watcher socket ${this.socket} did not answer within ${this.timeoutMs}ms`,
					"timeout",
					true,
				),
			);
		}, this.timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", chunk => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			try {
				const response: unknown = JSON.parse(line);
				if (!isRecord(response)) {
					finish(new WatcherError("watcher returned a non-object response", "protocol", false));
					return;
				}
				if (response.ok === true) {
					finish(undefined, response.data ?? {});
					return;
				}
				const message =
					typeof response.error === "string"
						? response.error
						: typeof response.detail === "string" && response.detail
							? response.detail
							: "watcher refused the request";
				const code = typeof response.code === "string" ? response.code : "refused";
				finish(new WatcherError(message, code, code === "busy" || code === "transport"));
			} catch (error) {
				finish(new WatcherError(`invalid watcher response: ${toError(error).message}`, "protocol", false));
			}
		});
		socket.on("error", error => {
			finish(new WatcherError(`watcher socket error: ${error.message}`, "transport", true));
		});
		socket.on("close", () => {
			if (!settled) finish(new WatcherError("watcher closed the socket without a response", "transport", true));
		});
		return await promise;
	}

	async register(record: HibernationRecord, retries = 3): Promise<RegisterAck> {
		const response = await this.request("hibernate.register", { record }, retries);
		const ack = parseRegisterAck(response);
		logger.info("Hibernation registered with watcher", {
			registrationId: ack.registrationId,
			epoch: ack.epoch,
			coordinator: ack.coordinator.acked,
		});
		return ack;
	}

	async status(registrationId: string): Promise<WatcherJobStatus> {
		return parseJobStatus(await this.request("hibernate.status", { registrationId }));
	}

	async list(): Promise<WatcherJobStatus[]> {
		const response = await this.request("hibernate.list");
		const value = isRecord(response) && Array.isArray(response.registrations) ? response.registrations : [];
		return value.filter(isRecord).map(parseJobStatus);
	}

	async cancel(registrationId: string, options: { stopJob?: boolean; reason?: string } = {}): Promise<unknown> {
		return await this.request("hibernate.cancel", {
			registrationId,
			stopJob: options.stopJob ?? false,
			reason: options.reason ?? "operator cancelled",
		});
	}

	async ack(
		registrationId: string,
		eventId: string,
		outcome: string,
		detail?: string,
	): Promise<unknown> {
		return await this.request("hibernate.ack", {
			registrationId,
			eventId,
			outcome,
			...(detail !== undefined && { detail }),
		});
	}

	ping(): Promise<unknown> {
		return this.request("ping", {}, 2);
	}
}

function parseRegisterAck(value: unknown): RegisterAck {
	if (!isRecord(value)) throw new WatcherError("register ack is not an object", "protocol", false);
	const coordinator = isRecord(value.coordinator) ? value.coordinator : {};
	if (typeof value.registrationId !== "string" || typeof value.accepted !== "boolean") {
		throw new WatcherError("register ack is missing required fields", "protocol", false);
	}
	return {
		accepted: value.accepted,
		registrationId: value.registrationId,
		...(typeof value.epoch === "number" && { epoch: value.epoch }),
		state: typeof value.state === "string" ? value.state : "unknown",
		coordinator: {
			acked: coordinator.acked === true,
			...(typeof coordinator.detail === "string" && { detail: coordinator.detail }),
		},
		...(typeof value.alreadyComplete === "boolean" && { alreadyComplete: value.alreadyComplete }),
		...(typeof value.unitActive === "boolean" && { unitActive: value.unitActive }),
	};
}

function parseJobStatus(value: unknown): WatcherJobStatus {
	if (!isRecord(value)) throw new WatcherError("job status is not an object", "protocol", false);
	const job = isRecord(value.job) ? value.job : {};
	const wake = isRecord(value.wake) ? value.wake : {};
	const pending = Array.isArray(wake.pendingEvents) ? wake.pendingEvents : [];
	return {
		registrationId: typeof value.registrationId === "string" ? value.registrationId : "",
		state: typeof value.state === "string" ? value.state : "unknown",
		job: {
			unit: typeof job.unit === "string" ? job.unit : "",
			active: job.active === true,
			...(typeof job.subState === "string" && { subState: job.subState }),
			...(typeof job.result === "string" && { result: job.result }),
			...(typeof job.exitCode === "number" && { exitCode: job.exitCode }),
			...(typeof job.elapsedMs === "number" && { elapsedMs: job.elapsedMs }),
			...(typeof job.stalled === "boolean" && { stalled: job.stalled }),
		},
		wake: {
			pendingEvents: pending.filter(isRecord).map(event => ({
				id: typeof event.id === "string" ? event.id : "",
				kind: typeof event.kind === "string" ? event.kind : "unknown",
				createdAt: typeof event.createdAt === "string" ? event.createdAt : "",
			})),
		},
		...(typeof value.lastError === "string" && { lastError: value.lastError }),
		...(typeof value.updatedAt === "string" && { updatedAt: value.updatedAt }),
	};
}
