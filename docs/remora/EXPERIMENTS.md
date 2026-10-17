# Experiment ledger

This file records decision state, including rejected and blocked work. Entries require exact source revisions, immutable run artifacts, verifier and resource state before being classified as measured.

## E0 — Initial repository and engine survey

- **Status:** source inspection completed; runtime benchmark not run.
- **OMP revision:** `df4f996e66a200ab7e0496114d43bdf85f32194d`.
- **Engine evidence:** checked Strata `src/program/generate.cpp`, `src/program/conv_cache_test.cpp`, and `serve/server.py` for cache configuration, prefix encoding and telemetry. No request was sent to the active server.
- **Finding:** OMP already has append-only context/prompt-cache key mechanisms and extensive Rust native tools; Strata already has prompt token encoding reuse, checkpoint/cache policy and request telemetry. A full rewrite or duplicate cache mechanism has no present evidence basis.
- **Benchmark reuse:** OMP already contains `packages/metaharness` with Harbor/edit/SnapCompact adapters and a native Terminal-Bench runner; REMORA should extend this artifact/run model, not fork a parallel manager.
- **Adjacent engine evidence:** Strata-Apex contains a same-GPU-model community RX 9060 XT report, but the CPU, RAM, OS, quantization, engine/client versions and config differ. Its results are reference data only; see `BASELINE.md`.
- **Next discriminator:** clean-upstream build and controlled task baseline during a safe idle window, followed by paired exact-prefix/cache-read measurement.
- **Result:** no speedup asserted; no code change retained.

## E1 — Baseline measurements

- **Status:** blocked on safe idle window.
- **Why:** an active local inference session/campaign was observed with high GPU memory and host RAM occupancy; the instruction prohibits interrupting or loading it.
- **Attempts:** source/config inspection only; no model request, build, test or server change.
- **Resolution condition:** active service and campaign are idle, with enough memory/CPU headroom for clean OMP build and repeated experiments; continue without restarting or reconfiguring the existing service.

## E2 — Stable prefix / Strata prompt-cache hypothesis

- **Status:** proposed, not executed.
- **Null hypothesis:** same-workload task time does not materially improve from further OMP prefix preservation because existing append-only state and Strata caches already capture reusable work, or because tools/compaction/model formatting alter the suffix.
- **Test:** first compare exact provider-rendered prompt token prefixes through tool-result turns and compare with OMP's stable message prefix offline; then, in paired same-task cold/warm runs, capture Strata `reused`, `prompt_read`, `prompt_ms`, task wall time and verifier state. Keep engine version, cache size, task state and prompt constant; change one factor per comparison. Strata's inspected reuse path matches token/image prefixes, not OMP's `promptCacheKey`; do not add a cache-key field without a verified consumer.
- **Pass criterion:** stable serialized prefix does not alter semantic request content; candidate reduces engine-read/prefill time and improves verified task/hour beyond measurement noise; quality noninferiority holds.
- **Fail/reject:** no prefix stability, no reduction in engine-read/critical path, or no end-to-end benefit; do not keep a cache shim.
- **Safety:** only run against an idle isolated benchmark instance/session and never reconfigure active production service.

## E3 — Engine controls and telemetry seam

- **Status:** implementation inspection completed; no runtime experiment.
- **MTP:** Strata's non-Metal default is `--spec 0`; request `strata_tune.spec_min_p` changes draft depth and `DONE` exposes offered/accepted counts. These are useful explanatory metrics, not task productivity evidence.
- **Expert residency:** `DONE` includes RAM/file expert reads and file MB, cache hits/lookups, offloaded reads, prompt chunk size and streamed expert counts. It does not isolate expert refill latency; collect a profiler trace before optimizing tier policy.
- **Scheduling:** request-scoped `pcie_frac`, layer-split `prefill_pipe`, and `aux_cpus` are available. Engine concurrency is an opt-in batch path; no concurrency experiment is safe or informative while the local engine/campaign is active.
- **Harness seam:** OMP's OpenAI adapter forwards configured `compat.extraBody`; Strata's request parser consumes its extension fields. This can express static configuration, but does not provide dynamic engine-state scheduling or route Strata telemetry into OMP task traces. Keep HTTP as the baseline and test this seam only after build and request-contract verification.
- **Next discriminator:** in an idle isolated run, capture the full request/response, verify custom-field round-trip and telemetry alignment, then compare one engine control at a time with task correctness and resource pressure.
