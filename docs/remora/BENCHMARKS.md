# REMORA benchmark protocol

## Objective

Measure **verified agent tasks completed per wall-clock hour** on identical hardware and workload. Token throughput, tool microbenchmarks and component timings are diagnostics, not the objective. A candidate fails if correctness or quality regresses, even if faster.

## Frozen task suite

Each task must be deterministic enough to verify, self-contained, solvable from a clean snapshot, and resistant to hidden answer leakage. Keep task text, starting commit, allowed tools, model configuration, expected output/tests, and difficulty label versioned and hash-addressed. The starter suite needs at least two tasks in each class before reporting suite-level productivity:

1. **Coding:** implement a narrowly specified feature with behavioral tests.
2. **Debugging:** diagnose a reproducible defect and add a regression test.
3. **Repository research:** answer questions with file/line evidence and an independent fact check.
4. **Multi-file editing:** change a coherent API across implementation, callers, tests and docs.
5. **Long-context:** navigate a large but relevant repository context, make a change, then verify with focused checks.

Do not use synthetic “finish in one tool call” tasks as a replacement for realistic tasks. Freeze hidden verifier tests before an experiment. Human review should score task correctness, completeness, evidence, unnecessary changes, and factual accuracy against a rubric blinded to arm.

The pinned SWE-bench Verified candidate pool and missing-stratum plan are tracked in [`WORKLOADS.md`](WORKLOADS.md). It is a screened seed catalog, not a frozen or validated suite.

## Reuse the existing benchmark harness

The fork already contains `packages/metaharness`: Harbor, edit-task and SnapCompact adapters, a native Terminal-Bench 2.1 runner, resumable runs, normalized traces, and experiment/run storage. Extend this infrastructure with the REMORA task/hour record and engine telemetry rather than creating a second scheduler, database or dashboard. The existing runner's configured workstation defaults include high concurrency; do not launch them on the active local engine. First schedule a dedicated, single-local-request profile in an idle window; cloud-only controls may be exercised separately without using the local GPU.


## Protocol

- Baseline arm is the exact clean upstream OMP commit before modifications. Candidate arm differs only by one registered experiment.
- Use clean, separate worktrees per attempt. Reset task repository, session state and untracked outputs between runs; do not let transcripts, caches or files leak between arms.
- Keep model, provider, engine binary/commit, quantization, max context, sampling, system prompt, tool schemas, task text, dependency versions and verifier fixed. If engine/prompt-cache state differs, classify into separate cold/warm strata rather than combining.
- Use paired runs per task and condition. Randomize whether baseline or candidate runs first. Repeat at least 10 pairs per task for an initial estimate; increase repetitions when confidence intervals overlap both material benefit and harm.
- Do not overlap local arms on the same GPU. If cloud models are used, capture provider/model/version, service tier and request limits, and run the local/cloud schedules under the same policy.
- Run correctness verifiers and independent quality review after each attempt. Never tune the candidate on the hidden test or silently alter benchmark tasks after seeing outcomes.
- Stop and mark invalid a run with external resource contention, model/service change, cancellation, incomplete telemetry, or a human intervention; retain the record with reason, do not discard silently.

## Measurements

Collect task wall time, time to first useful output, provider-call and tool-call durations, prompt and generated tokens, accepted output tokens where Strata reports them, retries, compactions, cache hit/reuse and prompt-read counts, MTP offers/accepts, expert-cache counters, CPU/GPU/RAM/SSD utilization, task correctness, quality score, and model/tool errors. Record both raw samples and summary statistics. Report medians and paired deltas with uncertainty (bootstrap 95% interval); report per-task results as well as aggregate task/hour.

For split tool/model critical paths, record overlapping intervals rather than adding durations as though sequential. The sum of tool-call durations may exceed wall time when tools run concurrently.

## Change isolation and integrity

- Benchmark scripts, task definitions and acceptance rules are protected artifacts. Self-optimization agents work on copies; after an experiment, compare their task-suite and scorer hashes with the protected versions.
- Experiment code may not edit the baseline checkout, task fixtures, scorer, or provenance collector.
- Store immutable commit hashes and run IDs, raw logs, resource trace, settings/environment, cache stratum, failure details and output hashes.
- Re-run baseline periodically to detect machine/model drift; do not pool measurements across engine versions or hardware states without explicit stratification.
- Keep a candidate only if the lower confidence bound for task productivity is positive and predeclared noninferiority gates hold for correctness and quality. Practical-effect threshold must be pre-registered; statistical significance alone is not enough.

## Status

No A/B runs have been executed. The local engine is active and must not receive benchmark load; baseline execution awaits a safe idle window and clean upstream build. `WORKLOADS.md` now records six source-screened SWE-bench candidates at a pinned dataset commit, but has no task payload hashes, validated agent/scorer isolation, repository-research tasks, or long-context tasks. No REMORA-specific task suite has been frozen or validated. The existing metaharness is source-audited only; no runner has been built or tested from this fork. Thus there is no measured baseline and no evidence-supported optimization prototype to retain.
