# REMORA architecture map: OMP × Strata-Apex

## Evidence boundary

This map is source-grounded from the fork at `df4f996e66a200ab7e0496114d43bdf85f32194d` and the checked-out Strata-Apex implementation. It describes interfaces and existing design, not measured performance. The active Strata server was not queried or modified.

## OMP request path

```text
coding-agent host / TUI / print / RPC / SDK
  -> AgentSession (session journal, model/tool settings, compaction/recovery)
  -> pi-agent Agent / agentLoop
  -> pi-ai streamSimple + provider adapter
  -> normalized AssistantMessageEvent stream
  -> agentLoop tool dispatch / session events
  -> coding-agent tool implementation
       -> Rust N-API/native workers where applicable
       -> LSP, shell, filesystem, network, MCP, or external process
  -> persist messages and rebuild next provider context
```

| Layer | Current ownership and authoritative source |
|---|---|
| Session lifecycle and persistence | `packages/coding-agent/src/session/agent-session.ts`; session journal and context reconstruction in `packages/coding-agent/src/session/session-manager.ts`, `session-context.ts`. `docs/provider-streaming-internals.md` maps persistence and event handling. |
| Agent loop and tool boundary | `packages/agent/src/agent-loop.ts` (`agentLoop`, `agentLoopContinue`, `runLoop`); loop streams normalized provider events, validates/dispatches tool calls, and returns agent events. The loop supports replaying unfinished runnable tool calls after recovery. |
| Provider and model catalog | `packages/ai/src/stream.ts` dispatches `streamSimple`; provider-specific adapters translate API-native stream events to `AssistantMessageEvent`. The catalog includes Z.AI `glm-5.3-flash` and OpenAI Codex GPT-5.6/6 Luna entries; actual account access, credentials, quotas and routing are not verified. See `docs/provider-streaming-internals.md` and `packages/catalog`. |
| Context and provider cache identity | `packages/agent/src/append-only-context.ts`; `AgentOptions.promptCacheKey`; `packages/coding-agent/src/session/agent-session.ts` and `session/session-manager.ts`. `appendOnlyContext` defaults to `auto`; source `shouldEnableAppendOnlyContext` auto-enables for local provider IDs and loopback/RFC1918/`.local` base URLs (plus selected providers/capabilities). A Strata endpoint configured as local should therefore use this existing mechanism unless explicitly disabled or routed differently; the active provider config was not inspected. This preserves stable message-prefix data, not proof that rendered/tokenized requests are identical. |
| Subagents and scheduling | `packages/coding-agent/src/task/index.ts`, `executor.ts`, `parallel.ts`, `spawn-run.ts`, `speculative-launch.ts`, `provider-concurrency.ts`. OMP already has session-scoped concurrency bounds, asynchronous jobs, worktree isolation, speculative launch for eligible streamed task batches, model-role routing, retry fallback, and resume/revival paths. |
| Compaction and history | `packages/agent/src/compaction/*` and `packages/coding-agent/src/session/{session-context,session-maintenance,agent-session}.ts`; compaction and branch summaries are journal entries, with overflow, incomplete-output, threshold and idle paths. See `docs/compaction.md`. |
| Memory | `packages/coding-agent/src/memory-backend/resolve.ts`; selectable `off`, `local`, `hindsight`, `mnemopi`, and `sharpshooter` backends. Recall is integrated into prompt preparation, with pre-compaction hooks; it is distinct from session-history reconstruction. |
| Goal campaigns | `packages/coding-agent/src/goals/runtime.ts` and `goal-tool.ts`; persisted goals track wall-clock/token budgets and pause/resume or budget-limited state. |
| Recovery and retries | `packages/coding-agent/src/session/retry-fallback-chains.ts` and session recovery paths; bounded exponential retry with jitter, provider/model fallback and retry events. Unnecessary repeated work must be measured from traces; retries are not inherently waste. |
| Native tools | `@oh-my-pi/pi-natives`: JS ESM loader + Rust Node-API addon, with native implementations in `crates/pi-natives` and supporting crates. Existing scope includes shell, PTY, process, AST/search/edit, workspace, and filesystem primitives. See `docs/natives-architecture.md`. |
| Shell | Model-facing `BashTool` in `packages/coding-agent/src/tools/bash.ts`; non-PTY execution uses `src/exec/bash-executor.ts` and a reusable embedded Rust shell. Shell sessions are per-session serialized; concurrent calls avoid sharing the same in-flight shell. See `docs/bash-tool-runtime.md`. |
| LSP | `packages/coding-agent/src/lsp/tool.ts`, `client.ts`, `config.ts`, `servers.ts`, diagnostics, edits and optional `lspmux`; tool is enabled/configurable, generally lazy-started. See `docs/tools/lsp.md` and `docs/lsp-config.md`. |
| Observability | `packages/agent/src/telemetry.ts`, `run-collector.ts`; optional OpenTelemetry run/step/tool usage and coverage. Provider/session usage also flows through coding-agent. Instrumentation is not yet an end-to-end task wall-clock decomposition. |
| Existing benchmark infrastructure | `packages/metaharness` already provides Harbor, edit and SnapCompact adapters, plus a native Terminal-Bench 2.1 runner; common experiments/runs/traces are stored in SQLite and exposed via REST/SSE. Reuse its artifact/run model rather than adding a parallel benchmark manager. |


Streaming is an async event stream with in-order push delivery; the provider transport does not have hard downstream backpressure. Partial tool-call JSON parsing is geometrically throttled, but every delta event is delivered. These facts identify possible queue/CPU research, not proof that streaming overhead is material.

## Strata-Apex request and cache interfaces

OMP can talk to Strata through compatible model-provider endpoints; this investigation has not found evidence of a direct OMP-to-engine native API requirement. Strata's own server and engine already expose the relevant request measurements in its local implementation:

- `serve/server.py` uses `PromptEncoder` when tokenizer resume points are supported. `tools/strata_tokenizer.py` keeps a bounded set of recent rendered prompts (the encoder default is four; server wiring uses its configured keep count); it reuses token IDs only through the longest shared special-token boundary that respects `plain` spans, then retokenizes the suffix. This exact tokenizer-work reduction is separate from engine KV checkpoint reuse and server session residency.
- Strata's engine resumes the deepest live/checkpoint state whose token IDs (and image keys, when present) exactly prefix the new prompt; independent sessions are parked in bounded slots when conversation caching is enabled. The inspected matching path compares token/image prefixes, not `AgentOptions.promptCacheKey`; no evidence shows that OMP's provider cache key is consumed by Strata. Relevant `generate.cpp` paths: prompt admission around 11949–12083 and cache configuration around 745–773.
- `--prompt-cache-spread` drops the checkpoint whose removal leaves the smallest gap relative to the newest checkpoint; retained points thin toward the shared root, so an edit `d` tokens before the end should reread roughly `d` tokens. Root retention pins common system prefixes when there are at least two slots; the one-slot case cannot retain root and leaf separately. A source comment estimates about 118 MB of copied running state per checkpoint for its described model geometry, so extra cache slots trade host RAM for reuse.
- `src/program/conv_cache_test.cpp` has a deterministic policy test for a 200-turn synthetic conversation: with six checkpoints, an edit 6K tokens behind the end should reuse more than the root under spread policy; ordinary LRU falls back to the root in the test scenario. This is an algorithm test, not an OMP task benchmark.
- `serve/server.py` parses per-request engine telemetry, including prompt tokens, reused/cache tokens, prompt tokens actually read, prompt/decode time, generated tokens, MTP draft offered/accepted, expert-tier hit information and offloaded expert reads. Its `request_timings` deliberately distinguishes new prompt work from reused tokens. Available fields depend on engine version.
- Strata's server serializes access to the single engine by default; parallel serving has a distinct batch path. Do not assume parallel local inference improves productivity on one 16-GB GPU; measure quality, memory and contention first.

### Engine controls and OMP adapter seam

- **MTP:** non-Metal Strata builds default to `--spec 0`; speculative decoding requires an enabled MTP runtime. `strata_tune.spec_min_p` can change the draft-probability floor per request, and the `DONE` record reports draft tokens offered and accepted. This is a decode-only mechanism; acceptance counts do not establish a task/hour gain or quality equivalence. Compare decode time and verified task outcomes on the same workload.
- **Expert-cache evidence:** the per-request `DONE` record exposes RAM/file expert read counts and file MB, plus hit/lookups, offloaded expert reads, prompt-chunk size and streamed expert blobs. It does not expose a direct refill-latency breakdown in those fields. Use request timings as coarse totals and add profiling before attributing delay to a particular tier.
- **Scheduling and prefill:** Strata supports request-scoped `pcie_frac`, `spec_min_p`, `prefill_pipe` and `aux_cpus` controls. `prefill_pipe` applies to layer-split prompt staging; batched prefill chunk size and expert-cache borrowing are configured separately. The default server path serializes one engine sequence. Treat concurrency, CPU affinity, transfer overlap and chunk tuning as isolated experiments with resource traces, not free speedups.
- **HTTP integration:** OMP's OpenAI Completions adapter merges `compat.extraBody` into the outgoing request body; catalog `extra-body` keys preserve literal wire names. Strata parses its request-scoped tuning fields. This is a possible static forwarding seam, not a typed Strata integration: OMP has no first-class mapping for those controls or Strata's accepted-draft/expert/cache telemetry, and a static extra body cannot react to per-request engine state. No forwarding patch is justified until the clean baseline and end-to-end field contract are tested.
- **Cloud delegation:** OMP already has model-role routing and provider fallback, but source inspection does not establish latency-aware scheduling. Cloud work can overlap local inference only when task dependencies permit; compare quality, service latency, cost and failure rates under a fixed routing policy.

- **Incremental context and result reuse:** OMP already maintains a stable system/tool prefix and append-only message log. Compaction pruning is cache-aware and can supersede stale reads; the content-addressed session blob store persists image/blob bytes, not arbitrary shell, filesystem or LSP results. No generic tool-result memoization path was found in the audited agent/coding-agent code. Reusing outputs across calls would require exact input, workspace/environment and permission identity plus freshness rules; semantic similarity is not a correctness key.

## Main testable integration hypothesis

**Hypothesis (unproven):** preserving OMP's existing stable message prefix can preserve exact rendered-token prefixes across tool-result turns, allowing Strata to resume a deeper live/checkpoint state and reduce actual prompt-read work. OMP's `promptCacheKey` is not assumed to affect Strata's prefix matching. OMP's append-only manager is not a new opportunity; the unresolved condition is whether its local-mode context survives provider conversion, Strata template rendering and tokenization unchanged over a real tool cycle, and whether the saved prompt-read time lies on the task critical path.

Before a runtime prototype, verify offline that identical transcript/tool/schema/model inputs yield the same rendered token prefix after tool-result turns; compare the common prefix length with OMP's retained stable message prefix. Then, during an idle isolated benchmark, measure Strata `reused`, `prompt_read`, prompt time, and task correctness in paired runs. Do not add an OMP cache-key field unless a source-supported Strata API consumes it. Never mutate the active production session to force cache behavior.

## Scope preserved

Do not replace OMP's provider registry, native tool stack, session journal, compaction, LSP, or task lifecycle based on code size or theoretical efficiency. Any proposed Rust/sidecar rewrite must first show a profiler-backed bottleneck and compare against the existing TypeScript/Bun + Rust N-API boundary on the same tasks.
