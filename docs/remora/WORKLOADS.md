# REMORA workload catalog

## Status: screened candidates, not a frozen suite

The pinned seed source is Harbor's `swebench-verified` dataset at harbor-framework/harbor-datasets commit [`37db108843a49bb31a592e37a75e2c40dc3f9749`](https://github.com/harbor-framework/harbor-datasets/tree/37db108843a49bb31a592e37a75e2c40dc3f9749/datasets/swebench-verified). Harbor's adapter describes this as the 500-instance human-validated SWE-bench Verified set and provides an isolated task environment and verifier. The task snapshots, instructions, metadata, and reference patch footprints below were inspected from that exact dataset commit. The dataset's own `task.toml` metadata calls the listed tasks `debugging`; REMORA's narrower strata are provisional classifications from the user prompt and reference-patch footprint, not Harbor's official labels.

This is a source-screened candidate pool only. No task was downloaded, built, run, independently rescored, or tested with the REMORA runner. The reference solution is for selection review only; it MUST NOT be mounted in the model-visible workspace or used as a task prompt. Verify the runner's actual mount boundaries before accepting any task. Do not report a five-stratum benchmark until at least two tasks in each stratum have frozen inputs, independent scoring, and validation.

## Candidate pool

| Proposed stratum | Pinned task ID | Selection evidence | Outstanding validation |
|---|---|---|---|
| Coding / requested behavior | `scikit-learn__scikit-learn-10297` | Issue requests adding `store_cv_values` support to `RidgeClassifierCV`; reference patch changes `sklearn/linear_model/ridge.py`. | Confirm task metadata and patch behavior against the pinned task; run hidden verifier in isolation; independent review. |
| Coding / requested behavior | `django__django-13741` | Issue requests making `ReadOnlyPasswordHashField` disabled by default; reference patch changes `django/contrib/auth/forms.py`. | Same; verify compatibility and verifier coverage. |
| Debugging / regression | `astropy__astropy-12907` | Reproducer shows nested `CompoundModel` separability matrix differs from expected; reference patch changes `astropy/modeling/separable.py`. | Verify task environment, regression tests, and solution quality independently. |
| Debugging / regression | `psf__requests-1142` | Issue reports unwanted `Content-Length` on GET; reference patch changes `requests/models.py`. | Verify task environment, intended GET/HEAD semantics, and hidden verifier. |
| Multi-file editing | `django__django-10554` | Queryset-union ordering reproducer; reference patch changes both `django/db/models/sql/compiler.py` and `django/db/models/sql/query.py`. | Confirm tests exercise caller-visible semantics and task can be solved without leaking reference patch. |
| Multi-file editing | `pydata__xarray-3095` | Deep copy changes Unicode index dtype; reference patch changes both `xarray/core/indexing.py` and `xarray/core/variable.py`. | Confirm task/verifier behavior and freeze a separate quality rubric. |

Pinned task instructions and metadata are available under each task directory at the dataset commit, for example [`django__django-10554`](https://github.com/harbor-framework/harbor-datasets/tree/37db108843a49bb31a592e37a75e2c40dc3f9749/datasets/swebench-verified/django__django-10554) and [`pydata__xarray-3095`](https://github.com/harbor-framework/harbor-datasets/tree/37db108843a49bb31a592e37a75e2c40dc3f9749/datasets/swebench-verified/pydata__xarray-3095). This catalog records candidate IDs and selection rationale, not task payload hashes or an executable manifest.

## Missing strata and freeze work

- **Repository research:** author at least two OMP-specific questions with answer rubrics grounded in the pinned source tree; require file/symbol evidence and blind independent fact checking. SWE-bench issue resolution is not a substitute for repository-research evaluation.
- **Long-context:** select at least two tasks only after measuring the relevant source/token footprint and showing that a broad, task-relevant repository investigation is necessary. Do not simulate this by padding prompts with irrelevant text. Existing multi-file candidates do not automatically qualify.
- **Suite validation:** resolve task IDs and commit/base revisions, inspect environment resource requirements, ensure the verifier and solution are inaccessible to the agent, freeze task/fixture/verifier hashes, test reset/isolation, and blind-score outputs before any A/B run.
- **Workload diversity:** this seed catalog is Python-heavy and does not measure OMP changes directly. Add carefully scoped OMP-native tasks or a representative non-Python repository task only with a separate, independently checked verifier.

The current machine's active OMP and Strata-Apex sessions make task-container execution and any model request unsafe. This catalog is read-only research; no Docker image was built or started.
