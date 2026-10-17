# Baseline profile and measurement status

## Current baseline status

**No independent end-to-end OMP-vs-Strata benchmark has been run. No throughput claim is made.** The active local Strata-Apex inference session must remain untouched, and an initial non-invasive host snapshot showed it occupying most available GPU memory and most available system RAM. A fresh build/test or inference run during that state would add resource contention and could disrupt the active campaign; it is deferred until an idle window.

The task's reported hardware is Ryzen 7 3700X, Radeon RX 9060 XT (16 GB, RDNA4/gfx1200), 32 GB DDR4, NVMe, CachyOS, ROCm/HIP. Those specifications are user-provided; this document does not independently validate every device detail.

| Item | Current value | Evidence status |
|---|---:|---|
| Coding decode median | ~66.6 accepted tokens/s | User-reported; model, prompt, cache state, sample size and timing protocol not yet independently reproduced. |
| Fresh prefill | ~547 tokens/s | User-reported; not independently reproduced. |
| Instantaneous decode | 40–120+ tokens/s | User-reported range; not comparable to a median without sampling definition. |
| Long context | up to 262K tokens | User-reported capability; not a throughput or quality result. |
| Verified tasks/hour | Unknown | Requires frozen benchmark tasks and human/verifier quality gates. |
| OMP host overhead | Unknown | No safe profile of the current local configuration. |
| Strata prompt reuse / prompt-read | Unknown for the active session | No requests sent; current server telemetry deliberately left untouched. |
| Build and test of unmodified fork | Not run | Deferred until safe idle resource window; no failure inferred. |

## Adjacent same-GPU reference (not this workstation's baseline)

Strata-Apex's local research checkout contains a community report for the same GPU model: Radeon RX 9060 XT 16 GB, gfx1200. It is useful prior measurement, not an independent reproduction of the user's setup:

| Reference setup | Result |
|---|---|
| Host / stack | Ryzen 7 9800X3D, 64 GB DDR5, Windows 11 HIP, Strata 0.1.40.3, OpenCode client; not the user's Ryzen 7 3700X, 32 GB DDR4, CachyOS/ROCm, OMP or active Strata build. |
| Model / runtime config | Qwen3.8-Flash-Next GSQ-RCO IQ2_XS / IQ3_XXS; prefill 8,192, MTP spec 4, resident KV 32,768, 122,880-token max context for recall. The user's Gyro-M quant and active config differ. |
| Fresh IQ2 prefill | 8,019 tokens: median 879.4 tok/s and 11.212 s; 28,180 tokens: 807.4 tok/s and 37.008 s. Three measured repetitions per cell; zero prompt reuse, but expert/OS caches were not fully cold. |
| Synthetic coding comparison | Three TypeScript tasks × three fresh attempts per quant; 9/9 passed for both; median task time 99.988 s IQ2 vs 136.321 s IQ3. This does not establish general quality equivalence or OMP productivity. |
| Near-limit context | One simple 113,501-input-token recall succeeded at 122,880 max context; not evidence of reliable coding at that context. |

Source: adjacent Strata-Apex checkout, `bench/results/2026-10-10-community-rx-9060-xt/{README.md,METHODS.md}`. Its own methodology records fixed arm order, missing model/engine artifact hashes, and background applications; treat it as a measured reference with reproducibility limits, not as transferable speedup evidence. In particular, its 879.4 tok/s fresh prefill does not supersede the user's reported ~547 tok/s: host, quantization, backend, software version and configuration differ.

## Existing architecture evidence affecting baseline interpretation

OMP already has provider request/session cache keys, an append-only context manager, model-specific provider adapters, task/subagent scheduling and concurrency limits, run-level telemetry hooks, compaction, and Rust native components. Therefore the test is not “does caching/parallelism/native code exist?” It is whether a particular end-to-end task workload triggers a measurable avoidable cost despite those mechanisms.

Strata has engine-side prompt checkpoints and per-request prompt/decode timing, cache reuse, prompt-read counts, MTP draft telemetry, and expert-cache counters in its server code. Use these engine-native counters alongside harness wall-clock; do not infer saved latency from a high cache hit ratio alone.

## Required baseline run

1. Select the exact OMP commit and keep an unmodified worktree; build and run the upstream project before any REMORA patch.
2. Wait for the user’s existing GPU service and active campaigns to be idle. Record GPU/RAM/CPU state, model/quantization, engine commit/binary hash, server command/config hash, OMP commit, dependency lockfiles and relevant environment settings. Do not change the existing server configuration.
3. Use the same five frozen task classes as `BENCHMARKS.md`, each in a clean per-run worktree. Preserve one task harness, model, max context, sampling/tool policy, and verification test across arms.
4. Run local workload only while idle; run independent cloud arm separately or with explicitly logged network/concurrency policy. Do not let A/B arms share one live session or its cache state.
5. For each task collect monotonic wall-clock start/end, first useful output, tool call start/end, provider-call boundaries, input/output/accepted tokens when available, retries/compactions, Strata engine `reused`, `prompt_read`, `prompt_ms`, `decode_ms`, MTP and expert counters, CPU/RAM/GPU utilization, verifier result, and quality review.
6. Pair A and B for identical task and state; randomize arm order; separate cold and warm cache strata. Use at least 10 paired runs per task for an initial estimate; expand if confidence intervals are wide. Report median, paired deltas and bootstrap 95% interval, including failures and censored runs.
7. Primary outcome is correctly completed, verified tasks per total wall-clock hour. A run that saves time while failing a quality gate counts as failure, not a speedup.

## Minimum data schema

Store one JSONL record per run, with immutable task and environment identifiers. Required fields:

```json
{
  "task_id": "frozen-suite-id",
  "arm": "upstream|candidate",
  "pair_id": "same-task-same-condition",
  "run_id": "unique-id",
  "source_commits": {"omp": "...", "strata": "..."},
  "model": "provider/model/quantization",
  "cache_state": "cold|warm|controlled",
  "hardware_state": {"gpu_busy_pct": null, "vram_used_bytes": null, "ram_available_bytes": null},
  "wall_ms": null,
  "first_useful_ms": null,
  "provider_calls": null,
  "tool_calls": null,
  "input_tokens": null,
  "output_tokens": null,
  "accepted_tokens": null,
  "strata": {"reused": null, "prompt_read": null, "prompt_ms": null, "decode_ms": null, "drafts_offered": null, "drafts_accepted": null, "expert_hits": null, "expert_lookups": null},
  "retry_count": null,
  "compaction_count": null,
  "verified": false,
  "quality_gate": "not_run|pass|fail",
  "failure_reason": null
}
```

Missing telemetry stays `null`; do not substitute an estimate. Keep prompts/output private where required; the provenance record can reference local redacted task IDs and hashes.
