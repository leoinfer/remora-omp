#!/usr/bin/env bash
# End-to-end hibernation demonstration against the fake watcher.
#
# Proves, with real processes and a real systemd user job:
#   - OMP genuinely exits (its pid is gone) while the job keeps running,
#   - the job completes independently and writes its result contract,
#   - a wake event resumes the SAME session file,
#   - a duplicate wake does not run a second turn.
#
# Requirements: bun (>=1.4.4), systemd --user with linger, curl, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CODING="$ROOT/packages/coding-agent"
BUN="${BUN:-bun}"
OMP_BIN="${OMP_BIN:-}"
PORT="${PORT:-18123}"
TMP="$(mktemp -d /tmp/omp-hiber-e2e.XXXXXX)"
AGENT="$TMP/agent"
WORK="$TMP/work"
SESSIONS="$AGENT/sessions"
STATE="$TMP/state"
EVENTS="$TMP/events.jsonl"
mkdir -p "$AGENT" "$WORK" "$SESSIONS" "$STATE"
PIDS=()
cleanup() {
	for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
	rm -rf "$TMP"
}
trap cleanup EXIT

cat > "$AGENT/models.yml" <<'YAML'
providers:
  mock:
    baseUrl: http://127.0.0.1:18123/v1
    api: openai-completions
    auth: none
    models:
      - id: mock-1
        name: Mock 1
        api: openai-completions
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 32000
        maxTokens: 4096
YAML
cat > "$AGENT/config.yml" <<'YAML'
hibernation:
  enabled: true
  watcherMode: required
  minWaitSeconds: 60
  maxWaitSeconds: 86400
  resumePolicy: auto
YAML
sed -i "s#http://127.0.0.1:18123/v1#http://127.0.0.1:${PORT}/v1#" "$AGENT/models.yml"

PORT="$PORT" MOCK_JOB_CWD="$WORK" \
MOCK_JOB_COMMAND="sleep 6; printf 'e2e-result' > out.txt" MOCK_JOB_ID=e2e-script \
	"$BUN" "$ROOT/scripts/hibernation/mock-openai.ts" >"$TMP/mock.log" 2>&1 &
PIDS+=($!)

FAKE_WATCHER_DIR="$STATE" FAKE_WATCHER_EVENTS="$EVENTS" \
	"$BUN" "$ROOT/scripts/hibernation/fake-watcher.ts" >"$TMP/watcher.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 100); do
	[[ -S "$STATE/watcher.sock" ]] && break
	sleep 0.1
done
[[ -S "$STATE/watcher.sock" ]] || { echo "fake watcher did not start"; cat "$TMP/watcher.log"; exit 1; }

run_omp() {
	if [[ -n "$OMP_BIN" ]]; then
		env PI_CODING_AGENT_DIR="$AGENT" \
			PI_CODING_AGENT_SESSION_DIR="$SESSIONS" \
			OMP_HIBERNATION_SOCKET="$STATE/watcher.sock" \
			OMP_HIBERNATION_TOKEN_FILE="$STATE/watcher.token" \
			"$OMP_BIN" "$@"
	else
		env PATH="$(dirname "$BUN"):$PATH" \
			PI_CODING_AGENT_DIR="$AGENT" \
			PI_CODING_AGENT_SESSION_DIR="$SESSIONS" \
			OMP_HIBERNATION_SOCKET="$STATE/watcher.sock" \
			OMP_HIBERNATION_TOKEN_FILE="$STATE/watcher.token" \
			"$BUN" --cwd="$CODING" src/cli.ts "$@"
	fi
}

echo "== hibernating =="
run_omp --cwd "$WORK" -p "HIBERNATE_NOW please" --model mock/mock-1 >"$TMP/hibernate.out" 2>&1
cat "$TMP/hibernate.out"
SESSION="$(find "$SESSIONS" -name '*.jsonl' | head -1)"
[[ -n "$SESSION" ]] || { echo "no session written"; exit 1; }
RECORD="$(find "$AGENT/hibernation/records" -name '*.json' | head -1)"
[[ -n "$RECORD" ]] || { echo "no hibernation record"; exit 1; }
python3 - "$RECORD" <<'PY'
import json, os, sys
record = json.load(open(sys.argv[1]))
pid = record["owner"]["pid"]
assert record["state"] == "HIBERNATED", record["state"]
try:
    os.kill(pid, 0)
except ProcessLookupError:
    print(f"omp pid {pid} is gone")
else:
    raise SystemExit(f"omp pid {pid} is still alive")
unit = record["job"]["unit"]
state = os.popen(f"systemctl --user is-active {unit}").read().strip()
assert state == "active", f"unit {unit} is {state}, expected active"
print(f"job unit {unit} active after omp exit")
PY
UNIT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["job"]["unit"])' "$RECORD")"
REG="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["registrationId"])' "$RECORD")"

for _ in $(seq 1 100); do
	state="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
	[[ "$state" != "active" ]] && break
	sleep 0.2
done
echo "== job finished; delivering wake =="
printf '{"registrationId":"%s","kind":"completed"}\n' "$REG" >>"$EVENTS"
# The fake watcher polls its control file; this is a real external-process
# integration test, so wait for it to ingest the event before waking.
sleep 1

BEFORE_LINES="$(wc -l <"$SESSION")"
run_omp hibernate wake --session "$SESSION"
AFTER_LINES="$(wc -l <"$SESSION")"
[[ "$AFTER_LINES" -gt "$BEFORE_LINES" ]] || { echo "wake did not append a turn"; exit 1; }
grep -q "omp-hibernation-wake" "$SESSION" || { echo "wake prompt missing from session"; exit 1; }
grep -q "e2e-result" "$WORK/out.txt" || { echo "artifact missing"; exit 1; }
echo "session grew $BEFORE_LINES -> $AFTER_LINES and contains the wake handoff"

echo "== duplicate wake =="
LINES_BEFORE_DUP="$(wc -l <"$SESSION")"
run_omp hibernate wake --session "$SESSION"
LINES_AFTER_DUP="$(wc -l <"$SESSION")"
[[ "$LINES_BEFORE_DUP" -eq "$LINES_AFTER_DUP" ]] || { echo "duplicate wake ran another turn"; exit 1; }
python3 - "$RECORD" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))
assert record["state"] == "ACTIVE", record["state"]
assert len([e for e in record["wake"]["events"] if e.get("outcome") == "resumed"]) == 1
print("exactly one resume event; record is ACTIVE")
PY
echo "== e2e: PASS =="
