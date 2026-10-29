# Durable hibernation and external supervision

OMP can suspend a whole session while an independent experiment runs, then
resume the **same** session when an external watcher has verified the result.
No model call happens while the session is suspended.

```
OMP                  systemd --user unit             watcher node (PC1)         coordinator (PC2)
 │ hibernate tool           │                              │                         │
 ├─ launch job ────────────►│ (independent)                │                         │
 ├─ durable record          │                              │                         │
 ├─ register ───────────────┼─────────────────────────────►│ durable + epoch ───────►│ durable row
 ├─ ack + safe exit         │                              │                         │
                          runs                             │ observe unit/result     │
                                                           │ verify artifacts        │
                                                           │ wake event ────────────►│ event + state
                                                           │◄──────── wake/cancel ───│ operator (optional)
                                                           │ `omp hibernate wake`    │
 OMP resumes same JSONL ◄──────────────────────────────────┤                         │
```

Responsibility split (deliberate):

| Owner | Responsibility |
|---|---|
| OMP | reasoning lifecycle: conversation, tool history, hibernation record, safe exit, exact-session resume |
| Watcher node/coordinator | execution lifecycle: monitor the job, verify the result contract, decide/queue wake, fence duplicate launches |
| Experiment runner | actual work: the command under a transient `systemd --user` unit |

## Where the code lives

OMP (`packages/coding-agent`):

| File | Role |
|---|---|
| `src/hibernation/types.ts` | record schema, state machine, strict parser |
| `src/hibernation/store.ts` | crash-safe record/journal, wake claims, process identity (boot id + `/proc` start ticks), recovery inspection |
| `src/hibernation/job.ts` | transient systemd unit, runner script, result contract, artifact verification, observation |
| `src/hibernation/watcher.ts` | local socket client (register/status/list/cancel/ack), capability token |
| `src/hibernation/service.ts` | policy, registration, wake planning/claim/consume, cancellation, recovery |
| `src/hibernation/extension.ts` | native `hibernate` tool, `/hibernate` and `/hibernation-status` commands; loaded by `sdk.ts` like the built-in autoresearch extension |
| `src/commands/hibernate.ts`, `src/cli/hibernate-cli.ts` | `omp hibernate status\|list\|wake\|cancel\|recover` (no model call) |
| `src/session/agent-session.ts` | a tool result carrying `details.terminal` ends the turn (used to release without a goodbye inference) |
| `packages/agent/src/{types,agent,agent-loop}.ts` | `lengthIsTerminal` so an automated resume treats a max-token answer as terminal |

Watcher (`ai-watcher-rs`):

| File | Role |
|---|---|
| `crates/aw-core/src/hibernate.rs` | shared record types, validation, owner liveness |
| `crates/aw-core/src/store.rs` | `hibernation`, `wake_event`, `node_command` tables and idempotent methods |
| `crates/aw-core/src/rpc.rs` | `hibernate.*` socket operations |
| `crates/aw-node/src/hibernate.rs` | supervisor thread: registration, observation, wake execution, coordinator sync |
| `crates/aw-coord/src/main.rs` | `hibernate_*` subcommands: durable mirror, wake commands, timeout reconcile |
| `crates/awctl/src/main.rs` | operator commands (node side) |

## Lifecycle

```
PREPARING ──ack──► HIBERNATED ──event──► WAKE_PENDING ──claim──► RESUMING ──turn──► ACTIVE
     │                 │                    │                     │
     └─ failure ──► FAILED                 ├─ cancel ──► CANCELLED
                                            └─ timeout ─► TIMED_OUT
RESUMING ── crash/failed turn ──► RECOVERY_REQUIRED ──manual retry──► RESUMING
```

Illegal edges are refused (`canTransition`). Every transition is appended to
`<agent-dir>/hibernation/journal.jsonl` with `fsync`. The latest record lives at
`<agent-dir>/hibernation/records/<session-key>.json`.

Record fields include the session id/path/header digest, working directory,
repo identity, job/unit/result directory, command digest, owner identity (PID +
process start ticks + boot id), host identity, watcher registration/epoch,
wake condition/policy/intent, generation, wake events, result contract,
diagnostics, and the resume acknowledgement.

## Agent interface

Tool `hibernate` (only when `hibernation.enabled`):

```json
{
  "jobId": "gpu-bench-7",
  "command": "cargo test --release --workspace",
  "cwd": "/home/leo/repo",
  "timeoutSeconds": 3600,
  "estimatedWaitSeconds": 900,
  "requiredArtifacts": ["target/release/receipt.json"],
  "successExitCodes": [0],
  "intent": {
    "objective": "verify the new scheduler path",
    "hypothesis": "the lock-free queue removes the regression",
    "successCriteria": "tests pass and p99 is below baseline",
    "lastAction": "added the queue",
    "nextActions": ["compare p99", "decide on merge"]
  }
}
```

The tool refuses when:

- hibernation is disabled,
- the session is not persisted,
- a live hibernation already exists for the session,
- the estimated wait is below `hibernation.minWaitSeconds` (default 300 s),
- an owned background job would be cancelled by exiting,
- queued user messages are waiting,
- `systemd --user` is unavailable,
- the watcher does not acknowledge the registration (unless
  `allowDegraded: true` and `hibernation.watcherMode: required` allows a
  coordinator-degraded ack).

`force` bypasses only the wait/background policy. A refused registration never
exits the session; the job keeps running and the agent can retry or stop it.

## Operator interface

```bash
omp hibernate list
omp hibernate status --session <id|path> [--json]
omp hibernate wake --session <id|path> [--event <wake-id>] [--force]
omp hibernate cancel --session <id|path> [--stop]
omp hibernate recover [--apply]
```

These read the durable record and systemd state; they never invoke a model.
`wake` runs the current OMP binary with `--resume <exact session>` in print mode
and a structured prompt containing the job id, exit code, result paths,
artifact digests, objective, hypothesis, success criteria, last action, next
actions, and the wake id. It exits 0 when the session recorded a turn.

Slash commands: `/hibernate [status|list|wake|cancel|recover]`,
`/hibernation-status`.

Watcher side:

```bash
aw-node --config node.toml hibernate-list
aw-node --config node.toml hibernate-status <registration>
aw-node --config node.toml hibernate-wake <registration> [wake-id] [--force]
aw-node --config node.toml hibernate-cancel <registration> [--stop]
awctl --config node.toml hibernate-status <registration>
# control node:
aw-coord hibernate_list
aw-coord hibernate_status --payload '{"registrationId":"hib-…"}'
aw-coord hibernate_wake --payload '{"registrationId":"hib-…"}'
aw-coord hibernate_cancel --payload '{"registrationId":"hib-…"}'
```

## Setup — primary machine (PC1, CachyOS)

1. Build/install OMP with this feature (source or compiled binary):

   ```bash
   cd packages/coding-agent
   PATH=/path/to/bun:$PATH bun run build      # dist/omp
   install -m755 dist/omp ~/.local/bin/omp-hibernate
   ```

   Keep the stock `omp` binary; invoke `omp-hibernate` for the new subcommand,
   or point your shell alias at it after verification.

2. Enable linger so the user manager (and jobs) survive logout:

   ```bash
   loginctl enable-linger "$USER"
   ```

3. Enable hibernation in `~/.omp/agent/config.yml`:

   ```yaml
   hibernation:
     enabled: true
     watcherMode: required      # refuse to exit without a watcher ack
     socket: ""                 # default $XDG_RUNTIME_DIR/ai-watcher-node.sock
     tokenFile: ""              # default ~/.omp/agent/hibernation/watcher.token
     minWaitSeconds: 300
     maxWaitSeconds: 86400
     resumePolicy: auto
     stallSeconds: 900
   ```

4. Build and run the watcher node (one daemon; it owns both handoff and
   hibernation supervision):

   ```bash
   cd /path/to/ai-watcher-rs
   cargo build --release
   install -m755 target/release/aw-node ~/.local/bin/aw-node
   install -m755 target/release/aw-coord ~/.local/bin/aw-coord   # control node only
   ```

   `node.toml`:

   ```toml
   node_id = "gpu-a"
   state_dir = "~/.local/state/ai-watcher-rs"
   socket = "$XDG_RUNTIME_DIR/ai-watcher-node.sock"

   [transport]
   coordinator = "root@100.120.21.90"     # Tailscale/LAN address of PC2
   remote_bin = "/usr/local/bin/aw-coord"
   sync_interval_s = 15
   ssh_timeout_s = 30
   strict_host_key = true

   [hibernation]
   enabled = true
   omp_bin = "/home/leo/.local/bin/omp-hibernate"
   poll_ms = 1000
   stall_s = 900
   sync_interval_s = 15
   wake_timeout_s = 3600
   max_wake_attempts = 3
   allowed_root = "~/.omp/agent/hibernation/jobs"
   token_file = "~/.omp/agent/hibernation/watcher.token"
   ```

5. Install the user service (`deploy/ai-watcher-node.service`):

   ```bash
   mkdir -p ~/.config/systemd/user
   cp deploy/ai-watcher-node.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now ai-watcher-node.service
   ```

   On first start the node writes the 0600 capability token at
   `token_file`; OMP reads the same file.

## Setup — control machine (PC2, always-on)

1. Copy `aw-coord` to `/usr/local/bin/aw-coord` and
   `deploy/ai-watcher-coordinator.service` to `/etc/systemd/system/`.
2. `coordinator.toml`:

   ```toml
   node_id = "controller-b"
   state_dir = "/var/lib/ai-watcher"
   sqlite_path = "jobs.sqlite3"
   nodes = ["gpu-a"]
   stale_after_s = 300
   max_retries = 2
   stall_after_s = 3600
   ```

3. Ensure PC1 can SSH to PC2 with a restricted key. PC1 only ever invokes
   `aw-coord <subcommand>`; PC2 never opens a connection to PC1 and never
   executes a command from PC1.
4. `systemctl enable --now ai-watcher-coordinator`.

The node polls the coordinator for `wake` / `cancel` / `stop` commands. That
direction is intentional: PC1 needs no inbound listener, and a coordinator
compromise cannot execute arbitrary shell on PC1.

## Safety and concurrency

- **Exactly-once at the workflow level**: the wake event is durable and unique
  per `(registration, generation, kind)`. OMP claims it under a file lease and
  records `consumedAt`; a duplicate wake exits 0 without running a turn.
- **Single active agent**: OMP's existing session ownership lease plus the
  record's owner identity (PID + start ticks + boot id) refuse a concurrent
  resume. `--force` is an explicit operator override.
- **Fast completion**: the node observes synchronously at registration. If the
  job already finished while the agent is still alive, the event is stored and
  the launch is deferred until the owner exits.
- **Watcher restart**: rows live in SQLite; on restart the supervisor reloads
  them, re-observes the unit, and resumes from the durable event.
- **Coordinator restart**: all decisions live in SQLite; commands are requeued
  after a delivery grace period.
- **Failure is not a restart loop**: a failed resume becomes
  `RECOVERY_REQUIRED` and stops automatic observation; a human or
  `omp hibernate wake --force` must retry.
- **No remote shell**: coordinator commands are action names bound to a
  registration already stored locally. The node runs only its configured
  `omp_bin hibernate wake`.
- **Timeout**: the node stops the unit and creates a `timeout` wake event; the
  agent investigates instead of waiting forever.
- **Stall**: a running unit whose result directory stops changing for
  `stall_s` produces a `stalled` event; the unit is not killed automatically.

## Process independence

The experiment runs in `systemd-run --user` with `KillMode=control-group` and
`RuntimeMaxSec=`; stdout/stderr and `result.json` live under
`~/.omp/agent/hibernation/jobs/<runId>/`. Consequences:

| Event | Effect |
|---|---|
| OMP exits or crashes | job continues |
| Watcher/coordinator dies | job continues; supervision resumes on restart |
| SSH/network lost | job continues |
| User logout | job continues while `linger` is enabled |
| Machine reboot / power loss | transient unit and job die. The record remains; `omp hibernate recover` reports the vanished job and the session can be resumed manually. |
| Unit timeout | systemd stops the cgroup; runner may not write a result → `vanished`/`timeout` |
| GPU cleanup | killing the unit's cgroup releases its processes; any GPU context owned by those processes is closed |

Reboot durability of the *experiment* requires a persistent unit (not the
default transient launch). That is intentionally out of scope for v1: the
record and session are durable, the experiment is not.

## Agent efficiency policy

Hibernation is refused below `minWaitSeconds` and while owned background jobs
or queued user messages exist. The resumed prompt tells the agent not to
re-run the experiment and not to manufacture work. Multiple independent
sessions/registrations are supported by the schema; the node supervises each
unit separately and the OMP store is per session.

## Known limitations

- The controller is not a highly available cluster: one coordinator SQLite
  database. Restart-safe, not machine-loss-safe; back up
  `jobs.sqlite3` if the control node is ephemeral.
- A `systemd --user` transient unit does not survive reboot. Use a persistent
  unit or re-launch after recovery if an experiment must span reboots.
- `systemd-run` and the runner require `python3` on PC1 for the result
  contract (JSON + artifact hashes). OMP core does not require Python.
- The wake prompt is bounded but includes the objective/intent text; it is not
  a summary of the entire transcript. The transcript itself is the source of
  truth.
- `finish_reason=length` is terminal only when the run passes
  `--length-is-terminal` (hibernation wakes do). Interactive runs keep their
  existing repair behavior.
- Structured result delivery is at-least-once at the transport level and
  exactly-once at the workflow level: the event claim is the idempotency gate;
  OMP does not promise exactly-once side effects inside the experiment.
- Resume policy `manual` requires an operator (or `aw-coord hibernate_wake`);
  no notification transport (email/Telegram) is included.

## Test record

See [`HIBERNATION_TEST_RECORD.md`](./HIBERNATION_TEST_RECORD.md) for commands,
results, and which guarantees are unverified.
