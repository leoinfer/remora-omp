/**
 * Test helper: a minimal ai-watcher node speaking the hibernation protocol.
 * It is intentionally strict about the wire shape so the OMP client is tested
 * against a different implementation, not against itself.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export interface FakeRegistration {
	registrationId: string;
	record: unknown;
	state: string;
	epoch: number;
	acknowledged: boolean;
	events: Array<{ id: string; kind: string; createdAt: string; consumedAt?: string; outcome?: string }>;
	cancelled?: { stopJob: boolean; reason: string };
	acks: Array<{ eventId: string; outcome: string; detail?: string }>;
}

export interface FakeWatcherOptions {
	dir: string;
	token?: string;
	coordinatorAcked?: boolean;
	alreadyComplete?: boolean;
}

export interface FakeWatcher {
	socket: string;
	tokenFile: string;
	registrations: Map<string, FakeRegistration>;
	addEvent(registrationId: string, kind: string, id?: string): { id: string; kind: string; createdAt: string };
	close(): Promise<void>;
}

export async function startFakeWatcher(options: FakeWatcherOptions): Promise<FakeWatcher> {
	const dir = options.dir;
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const socket = path.join(dir, "watcher.sock");
	const tokenFile = path.join(dir, "watcher.token");
	const token = options.token ?? "test-token";
	fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
	const registrations = new Map<string, FakeRegistration>();
	let epoch = 0;

	const reply = (socketRef: net.Socket, value: unknown): void => {
		socketRef.end(`${JSON.stringify(value)}\n`);
	};
	const fail = (socketRef: net.Socket, code: string, error: string): void => {
		socketRef.end(`${JSON.stringify({ ok: false, code, error })}\n`);
	};

	const server = net.createServer(connection => {
		let buffer = "";
		connection.setEncoding("utf8");
		connection.on("data", chunk => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const line = buffer.slice(0, newline);
			let request: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(line);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					fail(connection, "protocol", "request is not an object");
					return;
				}
				request = parsed as Record<string, unknown>;
			} catch {
				fail(connection, "protocol", "invalid json");
				return;
			}
			if (request.token !== token) {
				fail(connection, "unauthorized", "bad token");
				return;
			}
			const op = request.op;
			if (op === "ping") {
				reply(connection, { ok: true, data: { pong: true } });
				return;
			}
			if (op === "hibernate.register") {
				const record = request.record as { registrationId?: string; state?: string } | undefined;
				if (!record || typeof record.registrationId !== "string") {
					fail(connection, "invalid", "record missing");
					return;
				}
				const existing = registrations.get(record.registrationId);
				if (!existing) {
					epoch += 1;
					registrations.set(record.registrationId, {
						registrationId: record.registrationId,
						record,
						state: "HIBERNATED",
						epoch,
						acknowledged: options.coordinatorAcked !== false,
						events: [],
						acks: [],
					});
				}
				const registration = registrations.get(record.registrationId);
				if (!registration) throw new Error("registration vanished");
				reply(connection, {
					ok: true,
					data: {
						accepted: true,
						registrationId: registration.registrationId,
						epoch: registration.epoch,
						state: registration.state,
						coordinator: {
							acked: registration.acknowledged,
							...(registration.acknowledged ? {} : { detail: "coordinator unreachable (test)" }),
						},
						alreadyComplete: options.alreadyComplete === true,
						unitActive: true,
					},
				});
				return;
			}
			if (op === "hibernate.status") {
				const id = request.registrationId;
				const registration = typeof id === "string" ? registrations.get(id) : undefined;
				if (!registration) {
					fail(connection, "not_found", "no such registration");
					return;
				}
				reply(connection, {
					ok: true,
					data: {
						registrationId: registration.registrationId,
						state: registration.state,
						job: { unit: "fake.service", active: registration.events.length === 0 },
						wake: {
							pendingEvents: registration.events.filter(event => !event.consumedAt),
						},
						updatedAt: new Date().toISOString(),
					},
				});
				return;
			}
			if (op === "hibernate.cancel") {
				const id = request.registrationId;
				const registration = typeof id === "string" ? registrations.get(id) : undefined;
				if (!registration) {
					fail(connection, "not_found", "no such registration");
					return;
				}
				registration.cancelled = {
					stopJob: request.stopJob === true,
					reason: typeof request.reason === "string" ? request.reason : "",
				};
				registration.state = "CANCELLED";
				reply(connection, { ok: true, data: { cancelled: true } });
				return;
			}
			if (op === "hibernate.ack") {
				const id = request.registrationId;
				const registration = typeof id === "string" ? registrations.get(id) : undefined;
				if (!registration) {
					fail(connection, "not_found", "no such registration");
					return;
				}
				const eventId = typeof request.eventId === "string" ? request.eventId : "";
				const outcome = typeof request.outcome === "string" ? request.outcome : "";
				registration.acks.push({
					eventId,
					outcome,
					...(typeof request.detail === "string" && { detail: request.detail }),
				});
				const event = registration.events.find(candidate => candidate.id === eventId);
				if (event) {
					event.consumedAt = new Date().toISOString();
					event.outcome = outcome;
				}
				if (outcome === "resumed") registration.state = "ACTIVE";
				reply(connection, { ok: true, data: { acknowledged: true } });
				return;
			}
			fail(connection, "unsupported", `unknown op ${String(op)}`);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, () => resolve());
	});

	return {
		socket,
		tokenFile,
		registrations,
		addEvent(registrationId, kind, id) {
			const registration = registrations.get(registrationId);
			if (!registration) throw new Error(`no registration ${registrationId}`);
			const event = {
				id: id ?? `wake-${registration.events.length + 1}`,
				kind,
				createdAt: new Date().toISOString(),
			};
			registration.events.push(event);
			return event;
		},
		async close() {
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
			fs.rmSync(socket, { force: true });
		},
	};
}
