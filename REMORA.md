# REMORA-OMP research program

REMORA-OMP is a public, independently hosted fork of [Oh My Pi](https://github.com/can1357/oh-my-pi), focused on experimentally testing whether harness/engine co-design can increase verified agent work per hour on the existing machine. The upstream implementation and history are preserved; this checkout currently contains no performance optimization patches.

- Fork: <https://github.com/leoinfer/remora-omp>
- Upstream: <https://github.com/can1357/oh-my-pi>
- Engine under study: <https://github.com/leoinfer/strata-apex>
- Current fork base: `df4f996e66a200ab7e0496114d43bdf85f32194d` (2026-10-17)
- License: upstream MIT; retain `LICENSE` and all notices.

Research artifacts:

- [Architecture map](docs/remora/ARCHITECTURE.md)
- [Baseline status](docs/remora/BASELINE.md)
- [Benchmark protocol](docs/remora/BENCHMARKS.md)
- [Ranked opportunities](docs/remora/OPPORTUNITIES.md)
- [Performance model](docs/remora/PERFORMANCE_MODEL.md)
- [Roadmap](docs/remora/ROADMAP.md)
- [Upstream update procedure](docs/remora/UPSTREAM.md)
- [Prior art](docs/remora/PRIOR_ART.md)
- [Benchmark report status](docs/remora/BENCHMARK_REPORT.md)

## Evidence status

The user-supplied Strata-Apex throughput figures remain reported observations, not an independently reproduced baseline. Initial non-invasive inspection found an active local inference process with high GPU and RAM use. No request was sent to it, and no build, test, benchmark, server restart, or reconfiguration has been run. Benchmarking and the required clean-upstream build remain gated on a safe idle window; this is a safety decision, not evidence that the project fails to build.

No harness optimization or proof-of-concept has been retained. Existing OMP features already include provider prompt-cache keys, append-only context construction, task concurrency, speculative subagent launch, session persistence, context compaction, telemetry hooks, and Rust native components. The first experiment must measure cache reuse and task wall-clock contribution before duplicating or replacing those capabilities.
