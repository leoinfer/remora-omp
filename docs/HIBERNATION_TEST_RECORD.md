# Hibernation verification record

All commands were run on `cachyos-x8664` (OMP 18.13.3 source at
`/home/leo/research/omp-hibernation`, branch `feat/hibernate`) and the
controller `CT103` (`root@100.120.21.90`). Dates are UTC.

## Deterministic suites

| Command | Result |
|---|---|
| `cd packages/coding-agent && bun test test/hibernation-store.test.ts` | 10 pass / 0 fail |
| `bun test test/hibernation-job.test.ts` | 4 pass / 0 fail (real `systemd --user` units) |
| `bun test test/hibernation-watcher.test.ts` | 5 pass / 0 fail (fake node socket) |
| `bun test test/hibernation-wake.test.ts` | 5 pass / 0 fail |
| `bun test test/agent-session-async-delivery.test.ts test/agent-session-handoff.test.ts test/agent-session-eval-state-resume.test.ts` | 59 pass / 0 fail (compatibility) |
| `cd ../.. && cargo test -p aw-core --test store` | 9 pass / 0 fail (includes 3 hibernation idempotency cases) |
| `tsgo -p packages/coding-agent/tsconfig.json --noEmit` | clean |
| `tsgo -p packages/agent/tsconfig.json --noEmit` | clean |

## End-to-end: fake watcher (source and compiled binary)

`scripts/hibernation/e2e-omp.sh` starts a mock OpenAI provider and the fake
node, runs a real `sleep 6; printf … > out.txt` systemd unit, and asserts the
OMP pid is gone while the unit is active, the artifact exists, the same session
grows on wake, and a duplicate wake adds no turn.

| Run | Result |
|---|---|
| `bash scripts/hibernation/e2e-omp.sh` (bun source) | PASS |
| `OMP_BIN=packages/coding-agent/dist/omp bash scripts/hibernation/e2e-omp.sh` | PASS |

Output of the compiled run:

```
omp pid 443256 is gone
job unit omp-hiber-e2e-script-… active after omp exit
resumed 01a18978-… (event wake-1), exit 0
session grew 11 -> 15 and contains the wake handoff
already consumed: wake wake-1 was already consumed …
exactly one resume event; record is ACTIVE
== e2e: PASS ==
```

## End-to-end: real Rust watcher

`scripts/hibernation/e2e-watcher.sh` builds `aw-node`/`aw-coord`, runs the node
supervisor with a local coordinator, and waits for the node to resume the
session itself.

Result: `== e2e watcher: PASS ==` — OMP pid gone before wake, node verified
`out.txt`, exactly one resume, coordinator row `ACTIVE`.

## Cross-machine (PC1 node → PC2 coordinator)

- `aw-coord` installed at `/usr/local/bin/aw-coord` on CT103 with
  `/root/.config/ai-watcher/coordinator.toml`.
- PC1 node config used `transport.coordinator = root@100.120.21.90` over the
  existing Tailscale/LAN SSH path.
- Hibernated a 5 s job; the coordinator row moved
  `HIBERNATED → WAKE_PENDING → ACTIVE`, and the same OMP session recorded the
  wake handoff.
- Operator-initiated wake from PC2
  (`echo '{"registrationId":"…","wakeId":"manual-from-b-3"}' | ssh … aw-coord hibernate_wake`)
  resumed the exact session.
- Cancellation path was exercised through the local fake node; remote cancel
  uses the same command queue and was not separately exercised.

## Race/failure scenarios

| Scenario | Observation |
|---|---|
| A. Normal cycle | Passed (fake and real watcher; exact session grew) |
| B. Process termination | `os.kill(pid,0)` after hibernate raised `ProcessLookupError`; unit still `active` |
| C. Watcher restart | Killed `aw-node` 3 s into a 15 s job; unit stayed active; restarted node and the session resumed |
| D. Duplicate wake | Second `omp hibernate wake` printed `already consumed`, session line count unchanged, one `resumed` event |
| E. Fast completion race | `sleep 0.1` job: registration reported `alreadyComplete`; wake was deferred until the owner exited, then resumed |
| F. Experiment failure | `exit 3`: structured `failed` event; prompt contained exit code and log paths; one resume, no restart loop |
| G. Compatibility | 59 existing session/async/handoff tests pass; no test changes to existing behavior |
| H. Real local workload | Not run with a research workload. Synthetic jobs only. This is an explicit gap. |

## Unverified / bounded claims

- A machine restart kills the transient experiment unit; the record and session
  survive and `omp hibernate recover` reports it. Restart survival of the
  *experiment* requires a persistent unit and was not implemented.
- Coordinator SQLite is restart-safe, not replicated; loss of PC2 loses the
  registry.
- The controller's wake command was tested on this host with the node binary
  from the working tree. The systemd unit files are provided but were not
  installed as a boot-time service during the test.
- OMP `--restore` (interrupted-turn recovery) was not used for wake; wake uses
  `--resume` plus a new structured prompt by design.
- The `lengthIsTerminal` loop fix was type-checked and wired into wake runs, but
  the exact 200K-token replay scenario from the Strata handoff was not
  reproduced in this campaign.

## Operator commands exercised

```
omp hibernate list|status|wake|cancel|recover
aw-node --config /tmp/aw-node-prod.toml hibernate-status <id>
aw-node --config /tmp/aw-node-prod.toml hibernate-wake <id> --force
aw-coord hibernate_list
aw-coord hibernate_wake
```

## Changed files

OMP:
- `packages/agent/src/{types,agent,agent-loop}.ts`
- `packages/coding-agent/src/hibernation/*` (new)
- `packages/coding-agent/src/commands/hibernate.ts`, `src/cli/hibernate-cli.ts` (new)
- `packages/coding-agent/src/cli-commands.ts`, `src/cli/command-help.ts`
- `packages/coding-agent/src/config/all-settings.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/cli/{args,flag-tables}.ts`, `src/commands/launch-help.ts`
- `packages/coding-agent/test/hibernation-*.test.ts`, `test/hibernation-watcher-server.ts`
- `scripts/hibernation/{mock-openai.ts,fake-watcher.ts,e2e-omp.sh,e2e-watcher.sh}`
- `deploy/ai-watcher-{node,coordinator}.service`
- `docs/hibernation.md`, this file

Watcher (`/home/leo/research/ai-watcher-rs`):
- `crates/aw-core/src/hibernate.rs` (new)
- `crates/aw-core/src/store.rs`, `src/rpc.rs`, `src/config.rs`, `src/lib.rs`
- `crates/aw-node/src/hibernate.rs` (new), `src/main.rs`, `src/lib.rs`
- `crates/aw-coord/src/main.rs`
- `crates/awctl/src/main.rs`
- `crates/aw-core/tests/store.rs`
