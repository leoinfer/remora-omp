/**
 * Standalone fake watcher for the OMP-side end-to-end demo.
 * It accepts hibernation registrations, and appends wake events from
 * /tmp/omp-e2e/events.jsonl into the registration's pending list.
 */
import * as fs from "node:fs";
import { startFakeWatcher } from "../../packages/coding-agent/test/hibernation-watcher-server.ts";

const dir = process.env.FAKE_WATCHER_DIR ?? "/tmp/omp-e2e/watcher-state";
const watcher = await startFakeWatcher({ dir, token: "e2e-token" });
fs.writeFileSync("/tmp/omp-e2e/watcher.info.json", JSON.stringify({ socket: watcher.socket, tokenFile: watcher.tokenFile }));
console.log(`fake watcher ${watcher.socket}`);

const eventsFile = process.env.FAKE_WATCHER_EVENTS ?? "/tmp/omp-e2e/events.jsonl";
let offset = 0;
setInterval(() => {
	try {
		const text = fs.readFileSync(eventsFile, "utf8");
		const next = text.slice(offset);
		offset = text.length;
		for (const line of next.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as { registrationId?: string; kind?: string; id?: string };
				if (!event.registrationId) continue;
				const added = watcher.addEvent(event.registrationId, event.kind ?? "completed", event.id);
				console.log(`event ${added.id} (${added.kind}) for ${event.registrationId}`);
			} catch (error) {
				console.error("bad event line", error);
			}
		}
	} catch {}
}, 250);
