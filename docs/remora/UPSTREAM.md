# Upstream and fork maintenance

## Current repository state

- Public GitHub fork: `leoinfer/remora-omp` (parent `can1357/oh-my-pi`).
- `origin`: `https://github.com/leoinfer/remora-omp.git`.
- `upstream`: `https://github.com/can1357/oh-my-pi.git`.
- Current branch: `main`, clean at `df4f996e66a200ab7e0496114d43bdf85f32194d` (`2026-10-17`, `chore: bump version to 18.12.0`) when recorded.
- License and upstream notices remain in `LICENSE`; this fork does not remove OMP/Stencil/Pi attribution.

## Routine update

Keep local research commits on topic branches, not on `main`. Never rewrite a branch already pushed/shared. For each upstream sync:

```sh
git fetch upstream --prune
git switch main
git merge --ff-only upstream/main
git push origin main
```

If the fork has intentionally diverged on `main`, do not force-push or rebase it. Create `sync/upstream-YYYY-MM-DD` from the current fork `main`, merge `upstream/main`, resolve conflicts with upstream semantics and license notices preserved, run baseline tests/build in a safe resource window, inspect the merge diff, and publish the sync branch. Promote by a normal merge after review. For experiment branches, merge updated `main` forward; retain each experiment's original base commit and raw benchmark records.

## Before a merge

1. Record upstream old/new commit hashes and fetch date.
2. Review upstream release notes, migration notes, Cargo/Bun lockfile changes, native ABI/build scripts, provider behavior, and public API changes.
3. Re-run the unmodified smoke/build/test gate before applying REMORA optimization patches; then rebase the experiment conceptually by merging, not silently replacing its baseline.
4. Repeat a baseline subset if upstream changed model routing, serialization, session/context behavior, provider streaming, native interfaces or task scheduling.
5. Keep `LICENSE`, copyright headers, source attribution and upstream changes intact; check MIT obligations for copied/derived files.

## Source changes and contribution policy

This checkout is a forked research environment. Do not remove mature upstream functionality as part of an experiment. If proposing an upstream contribution, follow the current `CONTRIBUTING.md` process and discuss large architecture changes before opening a PR. Experimental result publication must identify upstream and fork commits separately.
