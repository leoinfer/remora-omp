// Minimal OpenAI-compatible chat-completions server for deterministic OMP tests.
// Echoes the last user message; can emit a `hibernate` tool call on demand.
import { isRecord } from "../../packages/utils/src/index.ts";

const port = Number(process.env.PORT ?? "18099");

interface ChatMessage {
	role?: string;
	content?: unknown;
}

interface ChatRequest {
	model?: string;
	stream?: boolean;
	messages?: ChatMessage[];
	tools?: Array<{ function?: { name?: string } }>;
	[key: string]: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function lastUserText(messages: ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.map(block => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
				.join("");
		}
	}
	return "";
}

interface ToolCallPlan {
	name: string;
	args: Record<string, unknown>;
}

function toolCallPlan(text: string, tools: ChatRequest["tools"]): ToolCallPlan | undefined {
	if (!tools?.some(tool => tool.function?.name === "hibernate")) return undefined;
	if (!text.includes("HIBERNATE_NOW")) return undefined;
	const cwd = process.env.MOCK_JOB_CWD ?? process.cwd();
	const command = process.env.MOCK_JOB_COMMAND ?? "sleep 2; printf ok > out.txt";
	const wait = Number(process.env.MOCK_ESTIMATED_WAIT ?? "600");
	return {
		name: "hibernate",
		args: {
			jobId: process.env.MOCK_JOB_ID ?? "e2e-smoke",
			command,
			cwd,
			estimatedWaitSeconds: Number.isFinite(wait) ? wait : 600,
			requiredArtifacts: ["out.txt"],
			intent: {
				objective: "prove hibernation resumes the exact session",
				hypothesis: "the watcher delivers the job result exactly once",
				successCriteria: "the resumed session contains the wake event and the artifact",
				lastAction: "launched the synthetic experiment",
				nextActions: ["inspect out.txt", "report the result"],
			},
		},
	};
}

function textFor(text: string): string {
	return `echo: ${text.match(/(?:^|\n)([^\n]*)$/)?.[1] ?? text}`;
}

const server = Bun.serve({
	port,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/v1/models") {
			return jsonResponse({
				object: "list",
				data: [{ id: "mock-1", object: "model", created: 0, owned_by: "mock" }],
			});
		}
		if (url.pathname !== "/v1/chat/completions") {
			return jsonResponse({ error: { message: `unknown path ${url.pathname}` } }, 404);
		}
		const raw: unknown = await req.json();
		if (!isRecord(raw)) return jsonResponse({ error: { message: "body is not an object" } }, 400);
		const body = raw as ChatRequest;
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const last = lastUserText(messages);
		console.log(
			`request tools=${(body.tools ?? []).map(tool => tool.function?.name ?? "?").join(",") || "none"} last=${JSON.stringify(last.slice(-120))}`,
		);
		const plan = toolCallPlan(last, body.tools);
		const text = textFor(last);
		const id = `chatcmpl-${Date.now()}`;
		const created = Math.floor(Date.now() / 1000);
		const model = body.model ?? "mock-1";
		const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
		if (!body.stream) {
			if (plan) {
				return jsonResponse({
					id,
					object: "chat.completion",
					created,
					model,
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "call_hibernate",
										type: "function",
										function: { name: plan.name, arguments: JSON.stringify(plan.args) },
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
					usage,
				});
			}
			return jsonResponse({
				id,
				object: "chat.completion",
				created,
				model,
				choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
				usage,
			});
		}
		const enc = new TextEncoder();
		const chunks: string[] = [];
		const push = (obj: unknown) => chunks.push(`data: ${JSON.stringify(obj)}\n\n`);
		push({
			id,
			object: "chat.completion.chunk",
			created,
			model,
			choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
		});
		if (plan) {
			const args = JSON.stringify(plan.args);
			push({
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_hibernate",
									type: "function",
									function: { name: plan.name, arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			});
			for (const piece of args.match(/.{1,60}/gs) ?? []) {
				push({
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [
						{
							index: 0,
							delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] },
							finish_reason: null,
						},
					],
				});
			}
			push({
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage,
			});
		} else {
			for (const piece of text.match(/.{1,40}/gs) ?? []) {
				push({
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
				});
			}
			push({
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage,
			});
		}
		chunks.push("data: [DONE]\n\n");
		const stream = new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
				controller.close();
			},
		});
		return new Response(stream, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
		});
	},
});

console.log(`mock-openai listening on ${server.port}`);
