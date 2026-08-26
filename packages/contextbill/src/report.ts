import { monthlyProjection } from './aggregate.js';
import { usd } from './cost.js';
import { LONG_SESSION_TURNS } from './waste.js';
import type { Report } from './types.js';

/**
 * Renders a Report to a single self-contained HTML document.
 *
 * Pure: same Report in, same string out. No file I/O, no network, no external
 * asset references of any kind — the output must open correctly from a file://
 * URL on a machine with no internet, because that is how it will be read.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function shortDate(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

function bar(share: number): string {
  const w = Math.max(0, Math.min(100, share));
  return `<div class="bar"><div class="bar-fill" style="width:${w.toFixed(2)}%"></div></div>`;
}

const STYLES = `
:root {
  --bg: #fbfaf8;
  --surface: #ffffff;
  --border: #e6e2db;
  --ink: #1a1917;
  --ink-soft: #6b6660;
  --accent: #b4541f;
  --accent-soft: #f0e2d8;
  --good: #2f6b45;
  --warn: #8a6410;
  --radius: 10px;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161513;
    --surface: #1f1e1b;
    --border: #33312d;
    --ink: #f0ede8;
    --ink-soft: #9c968d;
    --accent: #e08a55;
    --accent-soft: #3a2a1f;
    --good: #7cc094;
    --warn: #d9ae4e;
  }
}
:root[data-theme="dark"] {
  --bg: #161513;
  --surface: #1f1e1b;
  --border: #33312d;
  --ink: #f0ede8;
  --ink-soft: #9c968d;
  --accent: #e08a55;
  --accent-soft: #3a2a1f;
  --good: #7cc094;
  --warn: #d9ae4e;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem 5rem;
  background: var(--bg); color: var(--ink);
  font-family: var(--sans); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 60rem; margin: 0 auto; }
header { border-bottom: 2px solid var(--ink); padding-bottom: 1.25rem; margin-bottom: 2rem; }
h1 { font-size: 1.6rem; margin: 0 0 .3rem; letter-spacing: -.02em; }
h1 .mark { color: var(--accent); }
.sub { color: var(--ink-soft); font-size: .875rem; margin: 0; }
h2 {
  font-size: .78rem; text-transform: uppercase; letter-spacing: .1em;
  color: var(--ink-soft); margin: 2.75rem 0 .85rem; font-weight: 600;
}
.headline {
  display: flex; flex-wrap: wrap; gap: 1px;
  background: var(--border); border: 1px solid var(--border);
  border-radius: var(--radius); overflow: hidden; margin-bottom: .75rem;
}
.stat { background: var(--surface); padding: 1.1rem 1.25rem; flex: 1 1 12rem; }
.stat .v { font-size: 1.75rem; font-weight: 650; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
.stat .v.accent { color: var(--accent); }
.stat .k { font-size: .75rem; color: var(--ink-soft); margin-top: .15rem; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: .875rem; min-width: 32rem; }
th, td { text-align: left; padding: .5rem .7rem; border-bottom: 1px solid var(--border); }
th {
  font-size: .7rem; text-transform: uppercase; letter-spacing: .07em;
  color: var(--ink-soft); font-weight: 600; border-bottom: 1px solid var(--ink);
}
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: .82rem; }
tbody tr:last-child td { border-bottom: none; }
.bar { background: var(--border); border-radius: 3px; height: 6px; width: 100%; min-width: 4rem; overflow: hidden; }
.bar-fill { background: var(--accent); height: 100%; border-radius: 3px; }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.1rem 1.25rem;
}
.note {
  border-left: 3px solid var(--accent); background: var(--accent-soft);
  padding: .8rem 1rem; border-radius: 0 var(--radius) var(--radius) 0;
  font-size: .85rem; margin: .75rem 0;
}
.note strong { display: block; margin-bottom: .2rem; }
.empty { color: var(--ink-soft); font-size: .875rem; font-style: italic; }
code { font-family: var(--mono); font-size: .85em; background: var(--border); padding: .1em .35em; border-radius: 4px; }
footer {
  margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border);
  font-size: .78rem; color: var(--ink-soft);
}
footer p { margin: .3rem 0; }
.pill {
  display: inline-block; font-size: .7rem; font-family: var(--mono);
  padding: .1rem .45rem; border-radius: 4px; background: var(--border); color: var(--ink-soft);
}
`;

export function renderReport(r: Report): string {
  const monthly = monthlyProjection(r);
  const f = r.findings;

  const categoryRows = r.byCategory
    .filter((c) => c.usd > 0)
    .map(
      (c) => `<tr>
        <td>${esc(c.category)}</td>
        <td class="n">${esc(usd(c.usd))}</td>
        <td class="n">${esc(pct(c.share))}</td>
        <td style="width:28%">${bar(c.share)}</td>
      </tr>`,
    )
    .join('\n');

  const modelRows = r.byModel
    .map(
      (m) => `<tr>
        <td><code>${esc(m.model)}</code></td>
        <td class="n">${esc(usd(m.usd))}</td>
        <td class="n">${esc(pct(m.share))}</td>
        <td class="n">${num(m.turns)}</td>
      </tr>`,
    )
    .join('\n');

  const bucketRows = f.turnBuckets
    .map(
      (b) => `<tr>
        <td>${esc(b.label)} turns</td>
        <td class="n">${num(b.sessions)}</td>
        <td class="n">${esc(usd(b.usd))}</td>
        <td class="n">${esc(pct(b.share))}</td>
        <td style="width:24%">${bar(b.share)}</td>
      </tr>`,
    )
    .join('\n');

  const topRows = r.topSessions
    .map(
      (s) => `<tr>
        <td><code>${esc(s.id.slice(0, 8))}</code></td>
        <td>${esc(s.project)}</td>
        <td class="n">${num(s.turns)}</td>
        <td class="n">${esc(usd(s.usd))}</td>
        <td class="n">${esc(usd(s.usdPerTurn))}</td>
        <td>${s.producedFile ? '<span class="pill">wrote files</span>' : '<span class="pill">no file written</span>'}</td>
      </tr>`,
    )
    .join('\n');

  const noWriteRows = f.noFileWritten.length
    ? f.noFileWritten
        .map(
          (s) => `<tr>
        <td><code>${esc(s.id.slice(0, 8))}</code></td>
        <td>${esc(s.project)}</td>
        <td class="n">${num(s.turns)}</td>
        <td class="n">${esc(usd(s.usd))}</td>
        <td class="n">${esc(shortDate(s.startedAt))}</td>
      </tr>`,
        )
        .join('\n')
    : '';

  const deadRows = f.deadRuns.length
    ? f.deadRuns
        .map(
          (d) => `<tr>
        <td><code>${esc(d.id.slice(0, 8))}</code></td>
        <td>${esc(d.project)}</td>
        <td class="n">${num(d.turns)}</td>
        <td class="n">${num(d.bytes)} B</td>
        <td class="n">${esc(shortDate(d.startedAt))}</td>
      </tr>`,
        )
        .join('\n')
    : '';

  const unpricedNote = r.unpricedModelsSeen.length
    ? `<div class="note"><strong>Unpriced models excluded from the total</strong>
       ${r.unpricedModelsSeen.map((m) => `<code>${esc(m)}</code>`).join(' ')} —
       these appear in your transcripts but carry no rate in the price table, so their
       tokens are counted and their cost is not. The total below is an understatement
       by whatever they were worth.</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>contextbill report</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>context<span class="mark">bill</span></h1>
  <p class="sub">${num(r.transcriptCount)} transcripts · ${num(r.sessionCount)} sessions · ${num(r.turns)} turns · ${r.spanDays.toFixed(0)} days</p>
</header>

${unpricedNote}

<div class="headline">
  <div class="stat"><div class="v accent">${esc(usd(r.cost.total))}</div><div class="k">total, all transcripts on this machine</div></div>
  <div class="stat"><div class="v">${esc(usd(monthly))}</div><div class="k">projected per 30 days at this rate</div></div>
  <div class="stat"><div class="v">${num(f.medianStartupPrefix)}</div><div class="k">median tokens loaded before you type</div></div>
</div>

<h2>Where the money goes</h2>
<div class="card scroll">
<table>
  <thead><tr><th>Category</th><th class="n">Cost</th><th class="n">Share</th><th></th></tr></thead>
  <tbody>${categoryRows}</tbody>
</table>
</div>

<h2>The fixed tax</h2>
<div class="note">
  <strong>You paid ${esc(usd(f.startupPrefixUsd))} for context you never typed.</strong>
  Every session loads a system prompt, tool catalog, connector definitions and
  instruction files before it does any work — a median of <strong>${num(f.medianStartupPrefix)} tokens</strong> here.
  That block is written to cache once and then re-read on <em>every subsequent turn</em>,
  so a 500-turn session pays for it 500 times. It is the one line item that shrinks
  by deleting things rather than by working differently.
</div>

<h2>Cost by session length</h2>
<div class="card scroll">
<table>
  <thead><tr><th>Bucket</th><th class="n">Sessions</th><th class="n">Cost</th><th class="n">Share</th><th></th></tr></thead>
  <tbody>${bucketRows}</tbody>
</table>
</div>

<h2>Sessions with no file written</h2>
<div class="note">
  <strong>This is a prompt, not a verdict.</strong>
  These sessions ran ${LONG_SESSION_TURNS}+ turns without a single Write or Edit call.
  Some will be legitimate research or debugging; others will be a loop that went
  nowhere. contextbill cannot tell which, and does not guess — it surfaces them so
  you can look. Note a <code>Bash</code> command that writes a file does not count here.
</div>
${
  noWriteRows
    ? `<div class="card scroll"><table>
  <thead><tr><th>Session</th><th>Project</th><th class="n">Turns</th><th class="n">Cost</th><th class="n">Started</th></tr></thead>
  <tbody>${noWriteRows}</tbody>
</table></div>`
    : '<p class="empty">None — every long session on this machine wrote at least one file.</p>'
}

<h2>Runs that died on startup</h2>
<div class="note">
  <strong>A scheduled agent that exits before working looks identical to one that never fired.</strong>
  The task reports success either way. Transcript size is the only signal that
  separates them after the fact: a real run is kilobytes, a corpse is a few hundred bytes.
</div>
${
  deadRows
    ? `<div class="card scroll"><table>
  <thead><tr><th>Session</th><th>Project</th><th class="n">Turns</th><th class="n">Size</th><th class="n">Started</th></tr></thead>
  <tbody>${deadRows}</tbody>
</table></div>`
    : '<p class="empty">None — no transcripts look like dead starts.</p>'
}

<h2>Most expensive sessions</h2>
<div class="card scroll">
<table>
  <thead><tr><th>Session</th><th>Project</th><th class="n">Turns</th><th class="n">Cost</th><th class="n">Per turn</th><th>Output</th></tr></thead>
  <tbody>${topRows}</tbody>
</table>
</div>

<h2>By model</h2>
<div class="card scroll">
<table>
  <thead><tr><th>Model</th><th class="n">Cost</th><th class="n">Share</th><th class="n">Turns</th></tr></thead>
  <tbody>${modelRows}</tbody>
</table>
</div>

<h2>Token classes</h2>
<div class="card scroll">
<table>
  <thead><tr><th>Class</th><th class="n">Tokens</th><th class="n">Cost</th></tr></thead>
  <tbody>
    <tr><td>Input (uncached)</td><td class="n">${num(r.usage.input)}</td><td class="n">${esc(usd(r.cost.input))}</td></tr>
    <tr><td>Cache writes</td><td class="n">${num(r.usage.cacheWrite)}</td><td class="n">${esc(usd(r.cost.cacheWrite))}</td></tr>
    <tr><td>Cache reads</td><td class="n">${num(r.usage.cacheRead)}</td><td class="n">${esc(usd(r.cost.cacheRead))}</td></tr>
    <tr><td>Output</td><td class="n">${num(r.usage.output)}</td><td class="n">${esc(usd(r.cost.output))}</td></tr>
  </tbody>
</table>
</div>

<footer>
  <p>Generated ${esc(r.generatedAt)} by contextbill.</p>
  <p>Prices from the bundled table dated <strong>${esc(r.priceTableDate)}</strong>. Anthropic
     first-party API rates; Bedrock and Vertex are priced separately and are not modelled.</p>
  <p>Cache writes billed at the <strong>${esc(r.cacheTtlAssumed)}</strong> TTL rate. Transcripts do not
     record which TTL was used, so this is an assumption, not a measurement — if your client
     used 1-hour caching and this says <code>5m</code>, the real figure is higher. Re-run with
     <code>--cache-ttl=1h</code> to see that number.</p>
  <p>Nothing in this report left your machine.</p>
</footer>

</div>
</body>
</html>
`;
}
