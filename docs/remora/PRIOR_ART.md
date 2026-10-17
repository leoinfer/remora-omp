# Prior art and research implications

This survey guides experiment design; none of the published speedups below are evidence for a REMORA-OMP gain on this machine. Papers evaluate different models, hardware, tasks and systems. Cite exact dataset releases and pin task environments in REMORA runs.

## Agent interfaces and execution systems

- **SWE-agent — Agent-Computer Interfaces Enable Automated Software Engineering** (Yang et al., 2024): studies how a purpose-built agent-computer interface changes repository navigation, editing and test execution. Implication: measure tool interface/result shape and task success, not just interpreter CPU. OMP already has many structured tools and native implementations; compare an interface change as a controlled task experiment, not a rewrite. [Paper](https://arxiv.org/abs/2405.15793)
- **SGLang — Efficient Execution of Structured Language Model Programs** (Zheng et al., 2023/2024): combines a frontend for structured multi-call programs with a runtime; RadixAttention reuses exact shared-prefix KV state and the paper reports up to 6.4× throughput on selected inference workloads. Implication: exact prefix reuse and explicit execution graphs are viable systems ideas, but the reported throughput is not coding-task productivity and not comparable to Strata-Apex on this hardware. OMP already supports append-only context and parallel/speculative subagent launch; test the end-to-end cache hit/critical path before importing a different runtime boundary. [Paper](https://arxiv.org/abs/2312.07104)

- **OMP's own “The Harness Problem” benchmark** (Stencil Labs, Feb. 2026): reports hashline edits compared with other edit formats over three runs of 180 synthetic React mutation tasks, four tools and 16 models. This is directly relevant evidence that tool-interface design can alter task outcomes, but it remains an upstream-reported, narrow edit benchmark—not a replicated same-machine task/hour result, and not evidence that a second harness is needed. Use it to motivate controlled tool-interface experiments only. [Article](https://stencil.so/blog/the-harness-problem)


## Task-level evaluation

- **SWE-bench Verified** is an official 500-instance human-validated subset. Its site reports a range of agent systems and a consistent mini-SWE-agent bash-only setup for model comparisons. It is useful as a reproducible external reference, but public historical tasks are not an uncontaminated measure of future capability; keep private/fresh holdouts and report exact agent version. [Official benchmark](https://www.swebench.com/verified.html) · [paper](https://arxiv.org/abs/2310.06770)
- **Terminal-Bench 2.0** (Merrill et al., 2026): 89 hard terminal tasks from real workflows, each with a unique environment, human-written solution and comprehensive verification tests. Its current Harbor-maintained repository is a continuous benchmark with tagged releases and recommends repeatedly running oracle solutions to validate an environment. Implication: frozen task versions, executable validators, oracle/reliability checks and task-level outcomes suit REMORA's goal better than a token-only leaderboard. [Paper](https://arxiv.org/abs/2601.11868) · [current repository](https://github.com/harbor-framework/terminal-bench)
- **SWE-rebench** (Badertdinov et al., NeurIPS Datasets & Benchmarks 2025): proposes an automated pipeline for continuously collected interactive software-engineering tasks and explicitly motivates freshness to reduce contamination in static benchmarks. Implication: maintain a small frozen regression suite plus rotating, private, human-reviewed tasks; do not publish hidden task prompts or verifier solutions before evaluation. [Paper](https://arxiv.org/abs/2505.20411v2) · [NeurIPS record](https://proceedings.neurips.cc/paper_files/paper/2025/hash/21bec6ace947b1b58967b945c8ac0f10-Abstract-Datasets_and_Benchmarks_Track.html)

## Applied design to REMORA

1. Separate the **agent harness** (task/tool/context/scheduling policy), **provider adapter**, **Strata server**, and **engine** in provenance. A score is a combined-system result, not a base-model result.
2. Use deterministic task-specific tests and independent quality review; require a fresh holdout so optimizing the suite does not overfit it.
3. Reproduce exact prompt token/prefix identity when testing cache reuse. Radix/prefix-cache literature assumes identical token prefixes; semantic similarity is not a KV-cache key.
4. Keep local and cloud arms distinct unless the experiment is specifically about routing; record each model, service tier, network/cost policy and retries.
5. Keep external benchmark results and REMORA same-hardware paired results in separate tables. External paper speedups establish plausibility, not a performance target or bound for this setup.
