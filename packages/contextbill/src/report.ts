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

/** A break-even multiple. Two decimals: the difference between 3.1x and 3.15x is real money. */
function multiple(n: number): string {
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}x`;
}

/**
 * Drop the scheme from any URL in a citation before it reaches the page.
 *
 * The report must contain no `http://` or `https://` at all — a test asserts it,
 * because a single remote reference would leak that the report was opened and
 * would break the offline promise. A cited source is inert text and not a
 * reference, but "no scheme anywhere in the document" is a property a machine
 * can check and "this particular string is only prose" is not, so the scheme
 * goes and the host and path stay. The full URL survives in `--json` and in
 * `prices.json`, both of which a reader can open.
 */
function citation(source: string): string {
  return source.replace(/https?:\/\//g, '');
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
.pill.warn-pill { color: var(--warn); }
`;

/**
 * The plan-utilization section. Empty string when `--plan` was not given.
 *
 * Structured so the caveat cannot be separated from the number: the framing
 * note sits above the figure rather than in the footer, the multiple is only
 * printed when it was derived from whole months, and every partial month in the
 * trend table is labelled in its own row rather than by a footnote somebody has
 * to look for.
 */
function planSection(r: Report): string {
  const p = r.plan;
  if (p === undefined) return '';

  const metered = p.billing === 'metered';

  const monthRows = p.months
    .map((m) => {
      const coverage = m.complete
        ? '<span class="pill">whole month</span>'
        : `<span class="pill warn-pill">${m.daysCovered.toFixed(1)} of ${num(m.daysInMonth)} days</span>`;
      const ratioCell = m.ratio === null ? '—' : esc(multiple(m.ratio));
      return `<tr>
        <td><code>${esc(m.month)}</code></td>
        <td class="n">${esc(usd(m.usd))}</td>
        <td class="n">${num(m.turns)}</td>
        <td class="n">${ratioCell}</td>
        <td>${coverage}</td>
      </tr>`;
    })
    .join('\n');

  // The headline is the one number a reader will screenshot, so it is the one
  // that must refuse to exist rather than be approximated. No complete month
  // means no multiple — not a smaller multiple, not an asterisked one.
  const headline = metered
    ? `<div class="headline">
  <div class="stat"><div class="v accent">${esc(usd(r.cost.total))}</div><div class="k">API-equivalent value of all usage read</div></div>
  <div class="stat"><div class="v">metered</div><div class="k">${esc(p.label)} bills per token, so there is no flat fee to divide by</div></div>
</div>`
    : p.ratio === null
      ? `<div class="headline">
  <div class="stat"><div class="v accent">${esc(usd(r.cost.total))}</div><div class="k">API-equivalent value of all usage read</div></div>
  <div class="stat"><div class="v">${esc(usd(p.usdPerMonth ?? 0))}</div><div class="k">${esc(p.label)}, per month</div></div>
  <div class="stat"><div class="v">no whole month</div><div class="k">no break-even multiple can be computed</div></div>
</div>`
      : `<div class="headline">
  <div class="stat"><div class="v accent">${esc(usd(p.completeUsd))}</div><div class="k">API-equivalent value across ${num(p.completeMonths)} whole month(s)</div></div>
  <div class="stat"><div class="v">${esc(usd(p.completePlanUsd ?? 0))}</div><div class="k">${esc(p.label)} over the same months</div></div>
  <div class="stat"><div class="v accent">${esc(multiple(p.ratio))}</div><div class="k">break-even multiple over whole months only</div></div>
</div>`;

  const framing = metered
    ? `<div class="note">
  <strong>You are on metered billing, so this is the closest thing here to an invoice — and it is still an estimate.</strong>
  ${esc(p.label)} charges per token at the rates in the bundled table, so the total above is
  what those tokens are worth at those rates. It is not your bill: the cache-write TTL is an
  assumption rather than a measurement, unpriced models drop out, and this reads transcripts
  on this machine rather than an account. Check the invoice for the invoice.
</div>`
    : `<div class="note">
  <strong>This is API-equivalent value against a flat fee. It is not an invoice and not a refund.</strong>
  ${esc(p.label)} bills <strong>${esc(usd(p.usdPerMonth ?? 0))} a month whatever you do</strong>. The dollar
  figures here are what the same usage would have cost metered at API rates, so the multiple
  below says how much work the subscription absorbed — not that anyone owes anyone the
  difference. A month where you did nothing costs the same as a month where you did this.
  ${p.perSeat ? 'This plan is priced per seat and contextbill reads one machine, so the comparison is one person against one seat. ' : ''}
</div>`;

  const partialWarning = p.months.some((m) => !m.complete)
    ? `<div class="note">
  <strong>${num(p.months.filter((m) => !m.complete).length)} of these month(s) are only partly covered.</strong>
  A corpus starts at the oldest transcript that still exists and ends at the newest, so its
  first and last months are fragments and the month in progress always is. A fragment charged
  against a whole month's fee produces a multiple that is too LOW, which is why those rows are
  excluded from the figure above rather than folded into it. Coverage is measured from the span
  of the corpus: a month whose middle was deleted still reads as whole, because nothing in a
  transcript directory can tell a quiet week from a pruned one.
</div>`
    : '';

  const undatedWarning =
    p.undatedUsd > 0
      ? `<div class="note">
  <strong>${esc(usd(p.undatedUsd))} could not be placed in any month.</strong>
  Those transcripts carry no timestamp, so they are excluded from every row below and the
  monthly figures understate by that much.
</div>`
      : '';

  return `<h2>What your plan returned</h2>
${framing}
${headline}
${partialWarning}
${undatedWarning}
<div class="card scroll">
<table>
  <thead><tr><th>Month (UTC)</th><th class="n">API-equivalent value</th><th class="n">Turns</th><th class="n">vs plan fee</th><th>Coverage</th></tr></thead>
  <tbody>${monthRows}</tbody>
</table>
</div>
<div class="note">
  <strong>Plan prices are a vendor fact, not a measurement.</strong>
  ${esc(p.label)} read at <strong>${esc(p.priceDated)}</strong> from ${esc(citation(p.priceSource))}.
  contextbill cannot see what you actually pay — it cannot see your account at all — so a
  price that has moved since that date makes the multiple above wrong and nothing here will
  notice.${
    p.usdPerMonthAnnual !== null
      ? ` This plan also bills ${esc(usd(p.usdPerMonthAnnual))} a month annually; the multiple
    above divides by the higher monthly-billed price, so on annual billing it is an
    understatement.`
      : ''
  }
  A session is counted in the month it started, so one running across midnight on the last of
  the month lands entirely in the earlier month.
</div>
`;
}

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

  const projectRows = r.byProject
    .filter((p) => p.usd > 0)
    .map(
      (p) => `<tr>
        <td>${esc(p.project)}</td>
        <td class="n">${esc(usd(p.usd))}</td>
        <td class="n">${esc(pct(p.share))}</td>
        <td class="n">${num(p.sessions)}</td>
        <td class="n">${num(p.turns)}</td>
        <td class="n">${esc(usd(p.startupPrefixUsd))}</td>
        <td style="width:20%">${bar(p.share)}</td>
      </tr>`,
    )
    .join('\n');

  const connectorRows = r.byConnector
    .map(
      (c) => `<tr>
        <td>${esc(c.server)}</td>
        <td class="n">${esc(usd(c.usd))}</td>
        <td class="n">${esc(pct(c.share))}</td>
        <td class="n">${num(c.calls)}</td>
        <td style="width:24%">${bar(c.share)}</td>
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

  // Two different statements, and only the second is a caveat. The first says a
  // known double-count was removed; the second says a smaller one was measured
  // and deliberately left in place, because merging usage across transcripts is
  // a correction this codebase has no evidence for.
  // The residual is stated in DOLLARS, because that is the unit it is a residual
  // of. It used to be a count of message ids followed by "that much of the total
  // above is still counted twice" — two different quantities joined by a phrase
  // that reads as one, and a reader sizing the remaining error from the count
  // gets a number that can be off by a large factor either way.
  const d = r.deduplication;
  const duplicateShare = r.cost.total > 0 ? (100 * d.duplicatedUsd) / r.cost.total : 0;
  const sharedNote =
    d.sharedMessageIds > 0
      ? ` <strong>${num(d.sharedMessageIds)} message(s) are held by more than one transcript</strong>,
         across ${num(d.transcriptsSharingHistory)} files — a resumed session carrying its parent's
         history forward. Those copies are NOT merged, so about
         <strong>${esc(usd(d.duplicatedUsd))}</strong> of the total above, ${esc(pct(duplicateShare))},
         is counted twice. That figure prices the ${num(d.duplicatedTurns)} redundant copy(ies) at
         the mean cost per turn of the transcripts holding them: per-message dollars do not survive
         aggregation, so it is an estimate rather than a line item.`
      : '';
  const dedupNote =
    d.rewritesCollapsed > 0 || d.sharedMessageIds > 0
      ? `<div class="note">
  <strong>Streamed rewrites are counted once.</strong>
  A transcript records each assistant message several times while it streams, and
  every one of those lines repeats that message's running usage total rather than
  an increment. contextbill keeps the highest figure per message id and collapsed
  ${num(d.rewritesCollapsed)} restatement(s) here; ${num(d.unidentifiedRecords)}
  record(s) carried no message id and were counted as their own turns.${sharedNote}
</div>`
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
  <div class="stat"><div class="v accent">${esc(usd(r.cost.total))}</div><div class="k">at API rates, all transcripts on this machine</div></div>
  <div class="stat"><div class="v">${esc(usd(monthly))}</div><div class="k">projected per 30 days at this rate</div></div>
  <div class="stat"><div class="v">${num(f.medianStartupPrefix)}</div><div class="k">median tokens loaded before you type</div></div>
</div>

<div class="note">
  <strong>These are API-equivalent figures, not an invoice.</strong>
  Every dollar here is what this usage would cost metered at Anthropic's published
  first-party API rates, dated <strong>${esc(r.priceTableDate)}</strong>. If you work on a
  subscription you paid a flat fee instead, so treat these as a valuation of the
  usage and a way to compare sessions against each other — not as a restatement of
  what you were charged.
</div>

${planSection(r)}
<h2>Where the money goes</h2>
<div class="card scroll">
<table>
  <thead><tr><th>Category</th><th class="n">Cost</th><th class="n">Share</th><th></th></tr></thead>
  <tbody>${categoryRows}</tbody>
</table>
</div>

${
  r.byProject.length > 1
    ? `<h2>Where it went, by project</h2>
<div class="note">
  A project is one directory a session was started from, so work begun in a parent
  folder is filed under that parent rather than under the repository you were editing.
  Costs decompose exactly: these rows sum to the total above.
</div>
<div class="card scroll">
<table>
  <thead><tr><th>Project</th><th class="n">Cost</th><th class="n">Share</th><th class="n">Sessions</th><th class="n">Turns</th><th class="n">Fixed context</th><th></th></tr></thead>
  <tbody>${projectRows}</tbody>
</table>
</div>
`
    : ''
}
${
  r.byConnector.length > 0
    ? `<h2>What each connector cost</h2>
<div class="note">
  <strong>This table can only see connectors you actually called.</strong>
  A transcript records the calls that happened, not the tool catalog that was
  loaded, so a connector you never used leaves no trace here — it is paid for
  in the fixed context below and is invisible to this list. Compare these
  ${num(r.byConnector.length)} against the connectors you have enabled: the
  difference is being paid for on every turn and returning nothing.
  Browser automation appears here as its server and again in the category
  table; the two cut the same spend along different lines.
</div>
<div class="card scroll">
<table>
  <thead><tr><th>Server</th><th class="n">Cost</th><th class="n">Share</th><th class="n">Calls</th><th></th></tr></thead>
  <tbody>${connectorRows}</tbody>
</table>
</div>
`
    : ''
}
<h2>The fixed tax</h2>
<div class="note">
  <strong>${esc(usd(f.startupPrefixUsd))} of that total is context nobody typed.</strong>
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

${dedupNote}

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
