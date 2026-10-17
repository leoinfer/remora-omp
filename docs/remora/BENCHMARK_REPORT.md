# REMORA benchmark report

## Status: not run

No baseline build, test, agent task, inference request, or A/B run has been executed from this fork. The active Strata-Apex server and OMP agent campaigns remain in use. The user explicitly prohibited loading, restarting, reconfiguring, or interrupting those sessions. The most recent read-only process check found active OMP processes and a Strata server/engine; system memory reported about 3.8 GB available and no swap. A build or repeated workload now risks resource contention, so there is no performance report to fabricate.

The requested baseline cannot yet be established independently. User-reported starting values are in [`BASELINE.md`](BASELINE.md) and remain unverified. The research protocol is in [`BENCHMARKS.md`](BENCHMARKS.md). No candidate patch exists, so no optimization claim or microbenchmark is presented.

## Run record template

When safe, append a dated report with the following required facts:

- Run IDs, exact OMP and Strata commit/binary hashes, dependency lockfile hashes.
- Model, provider, quantization, server config hash, prompt/context limit, hardware snapshot, cache state and workload/task release.
- Baseline and candidate arm order, paired sample count, interruptions/exclusions with reasons.
- Per-task verified result, quality rating, wall time, first useful output, provider/tool intervals, calls/tokens, retry/compaction counts.
- Strata per-request reused tokens, actual prompt-read tokens, prompt/decode milliseconds, MTP offered/accepted and expert cache counters where available.
- Aggregate verified tasks/hour, per-class pass rate and paired speedup distribution with 95% uncertainty interval.
- All run logs/raw data and hashes; any change to scoring or task definitions.

## Acceptance status

- [ ] Clean upstream build and normal tests/smoke pass.
- [ ] Frozen task suite and hidden verifier validated.
- [ ] Baseline recorded with resource/cache strata.
- [ ] Candidate run uses identical task/model/quality gate with one registered change.
- [ ] Independent verifier signs off correctness and noninferiority.
- [ ] Paired result has sufficient repetitions and reports uncertainty.

No boxes are checked because the experiments have not run.
