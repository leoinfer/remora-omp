# Evidence-gated productivity roadmap

The 1.5×, 2×, 3× and 5×+ values are investigation targets, not promises. Progress means a verified-task/hour ratio on the frozen suite under paired, controlled conditions, with correctness and quality noninferiority. Do not multiply unrelated microbenchmarks to claim a target.

## Gate 0 — Safety and baseline

- Keep active OMP installation and Strata process/session untouched.
- Wait for a safe idle resource window; record hardware and engine/model state without changing it.
- Build and test the clean upstream OMP fork and run its normal smoke path before patches.
- Establish frozen task suite, protected verifier, resource traces and baseline paired repetitions.
- Record per-task provider calls, tool intervals, retries, compaction, tokens and Strata cache/prefill/decode telemetry.
- Stop if baseline repeatability or quality scoring is inadequate.

## Gate 1 — Reach 1.5× only with a measured mechanism

Use Amdahl bounds to choose one dominant, safe component (for example, a measured avoidable repeated prefill or clearly redundant call). Implement the smallest reversible patch or controlled configuration experiment. Require a positive paired task/hour gain with a confidence interval excluding the predeclared no-effect/practical threshold, no quality regression, and a clean rollback. If no candidate passes, retain no optimization and redesign instrumentation/tasks.

## Gate 2 — Test 2×

Require either one measured component to explain at least half of total baseline time and a credible route to near elimination, or multiple independently validated improvements whose combined measured critical-path savings reach the target. Re-run the complete suite at fixed workload mix, include long-context and multi-file tasks, and recheck memory/CPU/VRAM pressure and long-run reliability.

## Gate 3 — Test 3×

Requires 2/3 of elapsed time to be removed if relying on one component, or a demonstrated cross-layer change. A candidate may cross this gate only with repeatable verified task/hour gains across task classes; model-only token/s gains are insufficient. Preserve at least one untouched baseline worktree and frozen evaluation system.

## Gate 4 — Investigate 5×+

Fivefold productivity requires removing 80% of baseline critical-path time in one component or a major multi-component/architectural improvement. Consider model-routing, tool-call/task reduction, engine-aware scheduling, Rust workers or engine-native changes only if earlier profiles point there. Require extended campaign tests, failures, quality review, resource caps, audit trail and rollback procedure. An architecture rewrite is not accepted as evidence by itself.

## Research platform integrity

- Keep evaluators, task suite, scorer and provenance collector separately versioned and write-protected from autonomous candidate work.
- Experiments run in bounded worktrees with CPU/RAM/time/token/GPU admission limits. Local inference work requires an explicit idle window.
- Every change records owner, hypothesis, base commit, patch hash, model/engine versions, safety conditions, benchmark run IDs, results, decision and rollback commit.
- No self-optimizing agent may edit its own scorer or accept its own performance claim. An independent verifier reviews correctness and evidence.
- Preserve negative results and abandoned candidates; never silently discard unfavorable or resource-contended runs.
