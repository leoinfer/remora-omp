# Bottleneck and productivity model

## Task wall-time decomposition

For a verified task, model elapsed time as the critical path through a dependency graph, not as a simple sum of all work:

```text
T_task = critical_path(
    queue/admission,
    prompt encode + prefill/cache misses,
    model decode/tool planning,
    tool execution (CPU, IO, external process/LSP),
    state persistence/context rebuild,
    retries/recovery/compaction,
    waits/contention/network
)
```

Some independent tools or cloud delegation may overlap; overlapping duration is counted once in wall time. Token counts and accepted tokens are explanatory variables, not additive task-time terms. Track resource contention separately because it changes stage time and may reduce both model and tool throughput.

For a task class, a rough serial approximation is `T = T_model + T_tools + T_harness + T_wait + T_recovery`; all terms are currently **unmeasured** for the active local OMP/Strata configuration. Break model time into fresh prefill, cache-hit/reused prefix work, decode, provider/queue delay; separate harness CPU from OS/IO and network. Measure actual stage intervals and overlaps before fitting the approximation.

## Amdahl bound

If one fraction `p` of baseline elapsed time is accelerated by factor `s`, the maximum whole-task speedup is:

`S = 1 / ((1 - p) + p / s)`

Even infinitely accelerating that component cannot exceed `1 / (1 - p)`. For one isolated component to enable the target, it must account for at least:

| Target whole-task speedup | Minimum baseline time in that component, even with infinite acceleration |
|---:|---:|
| 1.5× | 33.3% |
| 2× | 50.0% |
| 3× | 66.7% |
| 5× | 80.0% |

Therefore a 2× speedup in prefill cannot produce 1.5× overall unless prefill is at least 66.7% of elapsed time. A faster Rust shell cannot yield a major overall win if tools are a small fraction. Exact requirements depend on multi-component changes and serial dependencies.

## Compute-related lower bounds

If a task consumes `I` fresh input tokens and `O` generated/accepted output tokens, with independently measured fresh prefill rate `R_p` and decode rate `R_d`, an optimistic compute-only bound is:

`T_model >= I / R_p + O / R_d`

This is not a reliable wall-time predictor when prefill overlaps decode, cache reuse changes `I`, MTP changes effective accepted tokens, there are prompt queues, tool calls or external waits. For a cache hit, count only tokens the engine actually reread; do not treat the full prompt as fresh. Record Strata's own `prompt_read`, `reused`, prompt/decode clocks, and MTP offers/accepts, all of which are exposed in server telemetry when the engine version reports them.

Reported 66.6 accepted tokens/s and 547 fresh-prefill tokens/s are user-provided starting observations, not validated constants. Instantaneous 40–120+ tokens/s is not a median or an accepted-token metric absent a sampling rule. These rates cannot be converted into tasks/hour without verified-task token demand, cache state, tool/recovery time and quality.

## Productivity and quality

For a fixed workload mix with verified task completion probability `q_i` and mean elapsed time `t_i`, raw throughput is not a simple average unless the task mix and scheduling are fixed. Report `verified completions / total wall hours` plus class-specific pass rates and time. A quality regression changes `q_i`, so a speedup on attempted tasks can reduce useful work. Treat correctness, completeness and output quality as hard gates; report failed runs and retries in the denominator.

Accepted-token efficiency (`accepted output tokens / task`) is not itself desirable: lower tokens count as improvement only when task results remain correct and sufficient. Similarly, cache hit ratio is not a wall-time reduction unless it saves prompt-read work on the critical path.

## Confidence labels

- **Measured:** obtained from recorded runs with frozen inputs, environment and verifier; show sample counts and uncertainty.
- **Analytical bound:** follows from a stated model or conservation constraint; assumptions and limits are explicit.
- **Speculative:** architecture or prior art suggests possibility, but no same-hardware task evidence exists.

At this baseline stage, user-supplied throughput figures are reported, resource snapshot is observational, Amdahl equations are analytical, and every productivity improvement is speculative.
