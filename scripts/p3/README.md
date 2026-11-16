# P3: symbol-filter evaluation on perturbed SWE-bench Lite

Measures how well `fleet check --semantic` predicts cross-agent interface
breaks, against textual baselines, on two-agent cases built from the 300
SWE-bench Lite instances.

## Reproduce

```bash
python scripts/p3/fetch_swebench_lite.py      # dataset + base files -> ~/.cache/switchyard-p3 (re-run until failed=0)
python scripts/p3/perturb.py --selftest
python scripts/p3/perturb.py                  # -> <cache>/cases.jsonl
npm run build -w @switchyardhq/switchyard
for k in 0 1 2 3; do node --experimental-strip-types scripts/p3/run-p3.ts --name p3 --shard $k/4 & done; wait
node --experimental-strip-types scripts/p3/run-p3.ts --name p3 --merge          # accuracy, all cases
node --experimental-strip-types scripts/p3/run-p3.ts --name p3-latency --limit 40  # latency, sequential
```

Override the cache with `SWITCHYARD_P3_CACHE`. Nothing from the upstream
repositories is committed; only the derived results are.

## Design

- **Agent A** is the instance's gold patch (a real upstream fix), or the gold
  patch plus one signature mutation of a callable the fix touched
  (`Mb`: add_required, remove_last, make_kwonly, rename_first, delete;
  `Mc`: add_optional, add_varkw, default_required).
- **Agent B** is a synthetic concurrent edit written against the base:
  `K1s`/`K1b` a new module calling a callable A changed the signature/body
  of, `K2` a caller of a callable A did not touch, `K3` a same-named local
  function with no import (shadowing), `K4`/`Mb-intra` a function appended to
  A's file that calls the changed callable.
- **Labels** come from `perturb.py`'s oracle, independent of the filter: it
  parses A's post file with CPython's `ast`, builds an `inspect.Signature`, and
  tries to bind B's call. Missing symbol or bind failure = conflict. The
  oracle is interface-level; behaviour changes behind a compatible signature
  are labelled "no conflict".
- **Every case runs on a real temporary git repository** (base commit, branch
  per A variant, branch per B case). Detectors see the branches as `fleet
  check` would: `file_overlap`, `merge_tree` (`git merge-tree --write-tree`),
  `symbol_legacy` (rules and I/O as first shipped), `symbol_precise` (current
  default), ablations of each precise rule, and `merge_tree+precise` (what
  the `--semantic` gate reports).

## Threats to validity

- B's edits are synthetic and simple (one call, placeholder arguments). Real
  agents' callers are more varied; the K-kinds bound the filter's name-matching
  behaviour rather than sample real agent behaviour.
- Mutations are injected; the gold patches alone contain 8 signature changes
  among 300 instances, 1 of them breaking for the generated caller.
- The provider file is the only file in each temporary repository, so
  cross-module effects (re-exports, inheritance across files) are not
  exercised.
- Python only: SWE-bench Lite has no TypeScript. The TS path is covered by
  unit tests, not by this evaluation.
- Accuracy runs use 4 concurrent shards; latency comes from the separate
  sequential run, on a shared developer laptop.
