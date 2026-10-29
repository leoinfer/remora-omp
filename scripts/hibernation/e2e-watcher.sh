#!/usr/bin/env bash
# End-to-end hibernation demonstration against the real Rust watcher
# (aw-node supervisor + aw-coord) with the coordinator in local mode.
#
# Proves automatic resumption: OMP exits, the node observes completion,
# verifies the result contract, launches `omp hibernate wake` itself, and the
# same session becomes ACTIVE without any operator action.
#
# Requirements: bun, cargo, systemd --user, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WATCH="$ROOT/../ai-watcher-rs"
CODING="$ROOT/packages/coding-agent"
BUN="${BUN:-bun}"
PORT="${PORT:-18124}"
TMP="$(mktemp -d /tmp/omp-hiber-watcher.XXXXXX)"
AGENT="$TMP/agent"
WORK="$TMP/work"
SESSIONS="$AGENT/sessions"
NODE_STATE="$TMP/node"
COORD_STATE="$TMP/coord"
mkdir -p "$AGENT" "$WORK" "$SESSIONS" "$NODE_STATE" "$COORD_STATE"
NODE_PID=""
MOCK_PID=""
cleanup() {
	[[ -n "$NODE_PID" ]] && kill "$NODE_PID" 2>/dev/null || true
	[[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
	rm -rf "$TMP"
}
trap 'status=$?; if [[ $status -ne 0 ]]; then rm -rf /tmp/omp-hiber-fail; cp -r "$TMP" /tmp/omp-hiber-fail; fi; cleanup' EXIT

[[ -d "$WATCH" ]] || { echo "missing ai-watcher-rs at $WATCH"; exit 1; }
BUN_ABS="$(command -v "$BUN")"
echo "== building watcher =="
(cd "$WATCH" && cargo build --release >/dev/null)
AW_NODE="$WATCH/target/release/aw-node"
AW_COORD="$WATCH/target/release/aw-coord"

cat > "$TMP/coord.toml" <<TOML
version = 2
node_id = "controller-b"
state_dir = "$COORD_STATE"
sqlite_path = "jobs.sqlite3"
nodes = ["gpu-a"]
stale_after_s = 300
max_retries = 2
stall_after_s = 3600
TOML
cat > "$TMP/node.toml" <<TOML
version = 2
node_id = "gpu-a"
state_dir = "$NODE_STATE"
socket = "$NODE_STATE/node.sock"

[transport]
coordinator = "local"
remote_bin = "$AW_COORD"
sync_interval_s = 2
ssh_timeout_s = 30
strict_host_key = false

[[engine]]
name = "unused"
unit = ""
start_argv = ["/bin/true"]
stop_argv = ["/bin/true"]
active_argv = ["/bin/false"]
health_url = "http://127.0.0.1:9/health"
start_timeout_s = 1
stop_timeout_s = 1

[agent]
bin = "/bin/true"
model = "mock"
session_dir = "$TMP"
idle_s = 1
drain_deadline_s = 1
term_grace_s = 1
turn_timeout_s = 5

[hibernation]
enabled = true
omp_bin = "$ROOT/scripts/hibernation/omp-source"
poll_ms = 300
stall_s = 120
sync_interval_s = 2
wake_timeout_s = 300
max_wake_attempts = 2
allowed_root = "$AGENT/hibernation/jobs"
token_file = "$AGENT/hibernation/watcher.token"
TOML

cat > "$ROOT/scripts/hibernation/omp-source" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
BUN="${BUN:-bun}"
ROOT="${OMP_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
exec "$BUN" --cwd="$ROOT/packages/coding-agent" src/cli.ts "$@"
SH
chmod +x "$ROOT/scripts/hibernation/omp-source"

cat > "$AGENT/models.yml" <<YAML
providers:
  mock:
    baseUrl: http://127.0.0.1:${PORT}/v1
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

PORT="$PORT" MOCK_JOB_CWD="$WORK" \
MOCK_JOB_COMMAND="sleep 5; printf 'watcher-result' > out.txt" MOCK_JOB_ID=e2e-watcher \
	"$BUN" "$ROOT/scripts/hibernation/mock-openai.ts" >"$TMP/mock.log" 2>&1 &
MOCK_PID=$!

BUN="$BUN_ABS" AW_COORD_CONFIG="$TMP/coord.toml" "$AW_NODE" --config "$TMP/node.toml" daemon >"$TMP/node.log" 2>&1 &
NODE_PID=$!
for _ in $(seq 1 100); do
	[[ -S "$NODE_STATE/node.sock" ]] && break
	sleep 0.1
done
[[ -S "$NODE_STATE/node.sock" ]] || { echo "node did not start"; cat "$TMP/node.log"; exit 1; }

echo "== hibernating with the real watcher =="
env PATH="$(dirname "$BUN"):$PATH" \
	PI_CODING_AGENT_DIR="$AGENT" \
	PI_CODING_AGENT_SESSION_DIR="$SESSIONS" \
	OMP_HIBERNATION_SOCKET="$NODE_STATE/node.sock" \
	OMP_HIBERNATION_TOKEN_FILE="$AGENT/hibernation/watcher.token" \
	OMP_SOURCE_ROOT="$ROOT" \
	"$BUN" --cwd="$CODING" src/cli.ts --cwd "$WORK" -p "HIBERNATE_NOW please" --model mock/mock-1 \
	>"$TMP/hibernate.out" 2>&1
cat "$TMP/hibernate.out"
RECORD="$(find "$AGENT/hibernation/records" -name '*.json' | head -1)"
SESSION="$(find "$SESSIONS" -name '*.jsonl' | head -1)"
[[ -n "$RECORD" && -n "$SESSION" ]] || { echo "missing record/session"; exit 1; }
python3 - "$RECORD" <<'PY'
import json, os, sys
record = json.load(open(sys.argv[1]))
pid = record["owner"]["pid"]
try:
    os.kill(pid, 0)
except ProcessLookupError:
    print(f"omp pid {pid} is gone before the watcher wakes it")
else:
    raise SystemExit(f"omp pid {pid} is still alive")
PY

echo "== waiting for the watcher to resume automatically =="
for _ in $(seq 1 300); do
	STATE="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["state"])' "$RECORD")"
	[[ "$STATE" == "ACTIVE" ]] && break
	sleep 0.2
done
[[ "$STATE" == "ACTIVE" ]] || { echo "watch did not resume the session (state=$STATE)"; exit 1; }
grep -q "omp-hibernation-wake" "$SESSION" || { echo "wake prompt missing"; exit 1; }
grep -q "watcher-result" "$WORK/out.txt" || { echo "artifact missing"; exit 1; }
python3 - "$RECORD" "$COORD_STATE/jobs.sqlite3" <<'PY'
import json, sqlite3, sys
record = json.load(open(sys.argv[1]))
assert record["state"] == "ACTIVE", record["state"]
assert len([e for e in record["wake"]["events"] if e.get("outcome") == "resumed"]) == 1
db = sqlite3.connect(sys.argv[2])
state = db.execute("select state from hibernation where registration_id=?", (record["registrationId"],)).fetchone()
assert state and state[0] == "ACTIVE", state
print("watcher and coordinator both report ACTIVE; exactly one resume")
PY
echo "== e2e watcher: PASS =="
