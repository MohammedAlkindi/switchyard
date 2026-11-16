#!/usr/bin/env node
/**
 * P3 evaluation: symbol-filter precision, recall and latency on perturbed
 * SWE-bench Lite traces.
 *
 * Inputs (built by fetch_swebench_lite.py + perturb.py, outside git):
 *   <cache>/cases.jsonl, <cache>/files/<iid>/<path>, <cache>/post/...
 *
 * For every SWE-bench Lite instance this builds ONE real temporary git repo:
 * main = the provider file at the instance's base commit; one branch per
 * agent-A variant (gold patch, gold patch + contract mutation); one branch
 * per agent-B perturbation. Each case is then scored by every detector on
 * the real branches, exactly as `fleet check` would see them.
 *
 * Usage (after `npm run build -w @switchyardhq/switchyard`):
 *   node --experimental-strip-types scripts/p3/run-p3.ts [--limit N]
 * Writes scripts/p3/results/p3-results.json and p3-summary.md.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import tmp from 'tmp';
import { LEGACY_SEMANTIC, PRECISE_SEMANTIC, predictSemanticConflicts } from '../../packages/switchyard/dist/lib/semantic.js';
import type { SemanticOptions } from '../../packages/switchyard/dist/lib/semantic.js';

tmp.setGracefulCleanup();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.SWITCHYARD_P3_CACHE ?? path.join(os.homedir(), '.cache', 'switchyard-p3');
const OUT_DIR = path.join(HERE, 'results');

interface Case {
  id: string;
  instance_id: string;
  repo: string;
  kind: string;
  mutation: string | null;
  provider_path: string;
  symbol: string;
  symbol_kind: string;
  label: boolean;
  oracle: string;
  a_post_file: string;
  b_mode: 'new' | 'append';
  b_path: string;
  b_content: string;
}

type Verdict = { flagged: boolean; ms: number };
type DetectorFn = (git: SimpleGit, a: string, b: string, c: Case, root: string) => Promise<Verdict>;

/** batched: blobs via one `git cat-file --batch`; otherwise one `git show` per file (the shipped I/O path). */
const semantic =
  (opts: SemanticOptions, batched = true): DetectorFn =>
  async (git, a, b, _c, root) => {
    const t = performance.now();
    const r = await predictSemanticConflicts(git, { name: 'A', branch: a }, { name: 'B', branch: b }, opts, batched ? { cwd: root } : {});
    return { flagged: r.hasHazards, ms: performance.now() - t };
  };

async function mergeTreeConflict(git: SimpleGit, a: string, b: string): Promise<boolean> {
  try {
    await git.raw(['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b]);
    return false;
  } catch {
    return true; // exit 1: conflicted
  }
}

const DETECTORS: Record<string, DetectorFn> = {
  file_overlap: async (_g, _a, _b, c) => ({ flagged: c.b_mode === 'append', ms: 0 }),
  merge_tree: async (git, a, b) => {
    const t = performance.now();
    const flagged = await mergeTreeConflict(git, a, b);
    return { flagged, ms: performance.now() - t };
  },
  // The filter as shipped in cd5ca48: legacy rules, per-file `git show`.
  symbol_legacy: semantic(LEGACY_SEMANTIC, false),
  symbol_precise: semantic(PRECISE_SEMANTIC),
  'precise-unbatched_io': semantic(PRECISE_SEMANTIC, false),
  'precise-no_added_refs': semantic({ ...PRECISE_SEMANTIC, addedReferencesOnly: false }),
  'precise-name_resolution': semantic({ ...PRECISE_SEMANTIC, resolution: 'name' }),
  'precise-any_change': semantic({ ...PRECISE_SEMANTIC, compat: 'any-change' }),
};

function stats(rows: { label: boolean; flagged: boolean }[]) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of rows) {
    if (r.label && r.flagged) tp += 1;
    else if (!r.label && r.flagged) fp += 1;
    else if (!r.label && !r.flagged) tn += 1;
    else fn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : NaN;
  const recall = tp + fn ? tp / (tp + fn) : NaN;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : NaN;
  const fpr = fp + tn ? fp / (fp + tn) : NaN;
  return { n: rows.length, tp, fp, tn, fn, precision, recall, f1, fpr };
}

/** Wilson 95% interval for a proportion. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [NaN, NaN];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
}

async function writeCommit(git: SimpleGit, root: string, rel: string, content: string, msg: string) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  await git.add([rel]);
  await git.commit(msg, undefined, { '--no-verify': null });
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  const cases: Case[] = readFileSync(path.join(CACHE, 'cases.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Case);
  const byInstance = new Map<string, Case[]>();
  for (const c of cases) byInstance.set(c.instance_id, [...(byInstance.get(c.instance_id) ?? []), c]);

  const argVal = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const name = argVal('--name') ?? 'p3';
  const shardArg = argVal('--shard'); // k/n
  const [shardK, shardN] = shardArg ? shardArg.split('/').map(Number) : [0, 1];
  const shardDir = path.join(OUT_DIR, 'shards');

  type Row = Case & { verdicts: Record<string, Verdict> };
  let results: Row[] = [];
  let done = 0;
  const started = performance.now();
  let idx = -1;
  if (process.argv.includes('--resummarize')) {
    // Recompute the summary from a finished run's per-case verdicts (no git work).
    const prev = JSON.parse(readFileSync(path.join(OUT_DIR, `${name}-results.json`), 'utf8')) as {
      meta: { instances: number };
      cases: Row[];
    };
    results.push(...prev.cases);
    done = prev.meta.instances;
    byInstance.clear();
  } else if (process.argv.includes('--merge')) {
    for (const f of readdirSync(shardDir).filter((x) => x.startsWith(`${name}.shard-`))) {
      const shard = JSON.parse(readFileSync(path.join(shardDir, f), 'utf8')) as { instances: number; rows: Row[] };
      results.push(...shard.rows);
      done += shard.instances;
    }
    byInstance.clear();
  }
  for (const [iid, group] of byInstance) {
    idx += 1;
    if (idx % (shardN as number) !== shardK) continue;
    if (done >= limit) break;
    done += 1;
    const dir = tmp.dirSync({ unsafeCleanup: true, prefix: 'sy-p3-' });
    const root = dir.name;
    const git = simpleGit(root);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'p3@example.invalid');
    await git.addConfig('user.name', 'p3');
    await git.addConfig('core.autocrlf', 'false');
    const first = group[0] as Case;
    const baseText = readFileSync(path.join(CACHE, 'files', iid, first.provider_path), 'utf8');
    await writeCommit(git, root, first.provider_path, baseText, 'base');

    // Agent-A branches, one per distinct post file.
    const aBranch = new Map<string, string>();
    for (const c of group) {
      if (aBranch.has(c.a_post_file)) continue;
      const name = `a${aBranch.size}`;
      await git.checkout(['-q', '-b', name, 'main']);
      await writeCommit(git, root, c.provider_path, readFileSync(path.join(CACHE, c.a_post_file), 'utf8'), `A ${c.a_post_file}`);
      aBranch.set(c.a_post_file, name);
    }
    for (const [k, c] of group.entries()) {
      const bName = `b${k}`;
      await git.checkout(['-q', '-b', bName, 'main']);
      await writeCommit(git, root, c.b_path, c.b_content, `B ${c.kind}`);
      const aName = aBranch.get(c.a_post_file) as string;
      const verdicts: Record<string, Verdict> = {};
      for (const [dname, fn] of Object.entries(DETECTORS)) verdicts[dname] = await fn(git, aName, bName, c, root);
      verdicts['merge_tree+precise'] = {
        flagged: (verdicts.merge_tree as Verdict).flagged || (verdicts.symbol_precise as Verdict).flagged,
        ms: (verdicts.merge_tree as Verdict).ms + (verdicts.symbol_precise as Verdict).ms,
      };
      results.push({ ...c, b_content: '', verdicts });
    }
    await git.checkout(['-q', 'main']);
    dir.removeCallback();
    if (done % 10 === 0) {
      const rate = (performance.now() - started) / done / 1000;
      console.error(`${done}/${byInstance.size} instances, ${results.length} cases, ${rate.toFixed(1)} s/instance`);
    }
  }

  if (shardArg) {
    mkdirSync(shardDir, { recursive: true });
    writeFileSync(path.join(shardDir, `${name}.shard-${shardK}.json`), JSON.stringify({ instances: done, rows: results }));
    console.error(`shard ${shardArg}: ${done} instances, ${results.length} cases`);
    return;
  }
  results = results.sort((x, y) => x.id.localeCompare(y.id));
  const detectors = Object.keys(results[0]?.verdicts ?? {});
  const kinds = [...new Set(results.map((r) => r.kind))].sort();
  const summary: Record<string, unknown> = {};
  for (const d of detectors) {
    const rows = results.map((r) => ({ label: r.label, flagged: (r.verdicts[d] as Verdict).flagged }));
    const all = stats(rows);
    const lat = results.map((r) => (r.verdicts[d] as Verdict).ms);
    const perKind: Record<string, ReturnType<typeof stats>> = {};
    for (const k of kinds) {
      perKind[k] = stats(results.filter((r) => r.kind === k).map((r) => ({ label: r.label, flagged: (r.verdicts[d] as Verdict).flagged })));
    }
    summary[d] = {
      ...all,
      precisionCI95: wilson(all.tp, all.tp + all.fp),
      recallCI95: wilson(all.tp, all.tp + all.fn),
      latencyMs: { mean: lat.reduce((x, y) => x + y, 0) / lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.max(...lat) },
      perKind,
    };
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const meta = process.argv.includes('--resummarize')
    ? {
        ...(JSON.parse(readFileSync(path.join(OUT_DIR, `${name}-results.json`), 'utf8')) as { meta: Record<string, unknown> }).meta,
        resummarizedAt: new Date().toISOString(),
      }
    : {
    dataset: 'princeton-nlp/SWE-bench_Lite (test, 300 instances)',
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${os.release()}`,
    git: (await simpleGit().raw(['--version'])).trim(),
    instances: done,
    mode: process.argv.includes('--merge') ? 'merged shards (run concurrently: use the sequential run for latency)' : 'sequential',
    cases: results.length,
    positives: results.filter((r) => r.label).length,
  };
  writeFileSync(
    path.join(OUT_DIR, `${name}-results.json`),
    JSON.stringify({ meta, summary, cases: results.map(({ b_content: _b, ...r }) => r) }, null, 1),
  );
  writeFileSync(path.join(OUT_DIR, `${name}-summary.md`), renderMarkdown(meta, summary, kinds));
  console.log(renderMarkdown(meta, summary, kinds));
}

function f3(x: number): string {
  return Number.isNaN(x) ? '—' : x.toFixed(3);
}

function renderMarkdown(meta: Record<string, unknown>, summary: Record<string, any>, kinds: string[]): string {
  const out: string[] = [];
  out.push('# P3: symbol-filter evaluation on perturbed SWE-bench Lite', '');
  out.push('Generated by `scripts/p3/run-p3.ts`. Do not edit by hand.', '');
  out.push('```json', JSON.stringify(meta, null, 1), '```', '');
  out.push('## All cases', '');
  out.push('| Detector | TP | FP | TN | FN | Precision [95% CI] | Recall [95% CI] | F1 | FPR | Latency mean / p50 / p95 ms |');
  out.push('|---|---:|---:|---:|---:|---|---|---:|---:|---|');
  for (const [d, s] of Object.entries(summary)) {
    out.push(
      `| ${d} | ${s.tp} | ${s.fp} | ${s.tn} | ${s.fn} | ${f3(s.precision)} [${f3(s.precisionCI95[0])}, ${f3(s.precisionCI95[1])}] | ${f3(s.recall)} [${f3(s.recallCI95[0])}, ${f3(s.recallCI95[1])}] | ${f3(s.f1)} | ${f3(s.fpr)} | ${s.latencyMs.mean.toFixed(1)} / ${s.latencyMs.p50.toFixed(1)} / ${s.latencyMs.p95.toFixed(1)} |`,
    );
  }
  out.push('', '## Flag rate by case kind (positives in the kind / cases)', '');
  out.push(`| Detector | ${kinds.map((k) => k).join(' | ')} |`);
  out.push(`|---|${kinds.map(() => '---').join('|')}|`);
  for (const [d, s] of Object.entries(summary)) {
    out.push(
      `| ${d} | ${kinds
        .map((k) => {
          const x = s.perKind[k];
          return `TP ${x.tp}/${x.tp + x.fn}, FP ${x.fp}/${x.fp + x.tn}`;
        })
        .join(' | ')} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
