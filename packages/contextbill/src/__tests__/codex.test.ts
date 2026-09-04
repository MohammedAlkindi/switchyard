import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aggregate } from '../aggregate.js';
import { parseArgs, summariseSources } from '../cli.js';
import { codexCategory, parseCodexRollout } from '../codex-parse.js';
import { cacheWriteMultiplier } from '../cost.js';
import { redactProject } from '../privacy.js';
import { scanCodexCorpus } from '../scan.js';
import type { PriceTable, SessionStat } from '../types.js';

/**
 * OpenAI Codex CLI rollouts, and the counter that makes them dangerous.
 *
 * `payload.info.total_token_usage` is a RUNNING TOTAL restated on every
 * `token_count` event, while `last_token_usage` is the most recent turn alone.
 * Summing the first multiplies the bill — the same failure the Claude reader's
 * streamed-rewrite deduplication exists to stop, arriving through a completely
 * different field.
 *
 * The `fixtures/codex/` corpus is hand-built to make all three candidate
 * readings produce different numbers, and the first test below computes the two
 * WRONG ones from the fixture and asserts they differ from what the parser
 * returned. That is what makes this suite a trap detector rather than a set of
 * magic numbers: if someone re-implements the parser the naive way, the
 * assertion that fails names the reason.
 *
 * Nothing here comes from a real session. Real rollouts hold private
 * conversation text and this repo is public.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8')) as PriceTable;
const CODEX = path.join(root, 'fixtures', 'codex');
const FIXTURE_HOME = 'C:\\Users\\testuser';

const { stats, unreadable } = scanCodexCorpus(CODEX);
function byId(id: string): SessionStat {
  const found = stats.find((s) => s.id === id);
  if (!found) throw new Error(`codex fixture ${id} not scanned`);
  return found;
}

/** Raw counter shape, as read straight back out of the fixture. */
interface RawCounter {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

interface RawLine {
  type?: string;
  payload?: {
    type?: string;
    info?: { total_token_usage?: RawCounter; last_token_usage?: RawCounter };
  };
}

/** Every `token_count` event in a fixture, in file order. */
function tokenEvents(file: string): { total: RawCounter; last: RawCounter }[] {
  const out: { total: RawCounter; last: RawCounter }[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let parsed: RawLine;
    try {
      parsed = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }
    if (parsed.type !== 'event_msg' || parsed.payload?.type !== 'token_count') continue;
    const total = parsed.payload.info?.total_token_usage;
    const last = parsed.payload.info?.last_token_usage;
    if (total && last) out.push({ total, last });
  }
  return out;
}

const SESSION_A = path.join(
  CODEX,
  '2026',
  '09',
  '01',
  'rollout-2026-09-01T09-00-00-fixture-session-a.jsonl',
);

describe('the cumulative-counter trap', () => {
  const a = byId('fixture-session-a');
  const events = tokenEvents(SESSION_A);

  it('has a fixture that actually distinguishes the three readings', () => {
    // Five token_count events for three real turns: one exact restatement and
    // one degenerate per-turn record sit on top. If this ever drops to three,
    // the fixture has stopped testing anything and every assertion below passes
    // for free.
    expect(events).toHaveLength(5);
  });

  it('counts one turn per advance of the counter, not one per event', () => {
    expect(a.turns).toBe(3);
    // The two events whose cumulative did not advance are restatements of spend
    // already recorded. Same field, same meaning as a Claude streamed rewrite.
    expect(a.usageRewrites).toBe(2);
  });

  it('reconciles exactly with the session counter it read', () => {
    // The invariant the whole parser is built around: the counter is the sum of
    // its own turns, so gating on it and summing the deltas has to land back on
    // the counter's final value, whatever order the events arrived in.
    const final = events[events.length - 1]?.total;
    expect(final).toBeDefined();
    expect(a.usage.input + a.usage.cacheRead + a.usage.cacheWrite).toBe(final?.input_tokens);
    expect(a.usage.output).toBe(final?.output_tokens);
    expect(a.usage.input + a.usage.cacheRead + a.usage.cacheWrite + a.usage.output).toBe(
      final?.total_tokens,
    );
  });

  it('does NOT sum the cumulative field', () => {
    // The catastrophic reading. Measured on a real 469-event rollout it reports
    // roughly 13.9 billion tokens against a true 59,901,944.
    const naive = events.reduce(
      (n, e) => ({
        input: n.input + e.total.input_tokens,
        output: n.output + e.total.output_tokens,
      }),
      { input: 0, output: 0 },
    );
    // 10,000 + 22,000 + 36,000 + 36,000 + 36,000 against a true 36,000.
    expect(naive.input).toBe(140000);
    expect(naive.output).toBe(3400);
    expect(a.usage.input + a.usage.cacheRead + a.usage.cacheWrite).not.toBe(naive.input);
    expect(a.usage.output).not.toBe(naive.output);
  });

  it('does NOT sum last_token_usage unguarded either', () => {
    // The plausible reading, and the one that actually gets written: it is the
    // per-turn field, so summing it looks right. It overstated three of the five
    // real rollouts on this machine — by 4.1%, 0.1% and 1.6% — because the
    // counter is restated verbatim when nothing advanced.
    const naive = events.reduce(
      (n, e) => ({
        input: n.input + e.last.input_tokens,
        output: n.output + e.last.output_tokens,
      }),
      { input: 0, output: 0 },
    );
    expect(naive.input).toBe(50000);
    expect(naive.output).toBe(1300);
    expect(a.usage.input + a.usage.cacheRead + a.usage.cacheWrite).not.toBe(naive.input);
    expect(a.usage.output).not.toBe(naive.output);
  });

  it('produces the one right answer', () => {
    expect(a.usage).toEqual({ input: 16000, cacheWrite: 0, cacheRead: 20000, output: 900 });
  });

  it('skips a restatement that rewinds the counter instead of trusting it', () => {
    // Session B replays turn one's cumulative after turn two has been recorded.
    // Accepting it would rewind the baseline and then double-count everything
    // after it: 21,000 input tokens would come out as 26,000.
    const b = byId('fixture-session-b');
    expect(b.usageRewrites).toBe(1);
    expect(b.usage.input + b.usage.cacheRead + b.usage.cacheWrite).toBe(21000);
  });
});

describe('what the token fields mean', () => {
  const a = byId('fixture-session-a');
  const events = tokenEvents(SESSION_A);

  it('treats reasoning_output_tokens as part of output, never as extra', () => {
    // Settled by arithmetic on 732 real events, not by reading a docs page:
    // total_tokens === input_tokens + output_tokens on every well-formed record,
    // and never input + output + reasoning. Adding reasoning here would report
    // 1,170 output tokens instead of 900 — and would inflate output on a real
    // corpus by 8-50% depending on the session.
    for (const e of events) {
      expect(e.total.total_tokens).toBe(e.total.input_tokens + e.total.output_tokens);
    }
    const reasoning = events[events.length - 1]?.total.reasoning_output_tokens ?? 0;
    expect(reasoning).toBe(270);
    expect(a.usage.output).toBe(900);
    expect(a.usage.output).not.toBe(900 + reasoning);
  });

  it('treats cached_input_tokens as part of input, never as a bucket beside it', () => {
    // Also measured: cached_input_tokens <= input_tokens on every record. So the
    // fresh half is what is left when the cached half comes out. Reading them as
    // separate buckets would report 36,000 fresh input tokens for session A
    // instead of 16,000, and price 20,000 cache reads at the full input rate.
    const final = events[events.length - 1]?.total;
    expect(final?.cached_input_tokens).toBe(20000);
    expect(a.usage.cacheRead).toBe(20000);
    expect(a.usage.input).toBe(16000);
    expect(a.usage.input + a.usage.cacheRead + a.usage.cacheWrite).toBe(final?.input_tokens);
  });

  it('reads the startup prefix from the first turn only', () => {
    // Turn one's whole input side: system prompt, tool catalog, AGENTS.md. On
    // later turns the same tokens come back as cached input, so counting them
    // again multiplies the figure.
    expect(a.startupPrefix).toBe(10000);
    expect(byId('fixture-session-b').startupPrefix).toBe(5000);
  });
});

describe('model attribution', () => {
  it('follows the model in force when it changes mid-session', () => {
    const b = byId('fixture-session-b');
    const five = b.byModel.find((m) => m.model === 'gpt-5.5');
    const six = b.byModel.find((m) => m.model === 'gpt-5.6-sol');
    expect(five?.turns).toBe(1);
    expect(five?.usage).toEqual({ input: 5000, cacheWrite: 0, cacheRead: 0, output: 100 });
    expect(six?.turns).toBe(2);
    expect(six?.usage).toEqual({ input: 6000, cacheWrite: 0, cacheRead: 10000, output: 300 });
  });

  it('marks every turn standard, because Codex records no fast tier', () => {
    for (const stat of stats) {
      for (const entry of stat.byModel) expect(entry.speed).toBe('standard');
    }
  });

  it('splits per model back to the session total', () => {
    const b = byId('fixture-session-b');
    const summed = b.byModel.reduce((n, m) => n + m.usage.input + m.usage.cacheRead, 0);
    expect(summed).toBe(b.usage.input + b.usage.cacheRead);
  });
});

describe('privacy: cwd is a machine path and is redacted like a slug', () => {
  it('encodes cwd into the same slug form the Claude reader produces', () => {
    // Codex writes the working directory verbatim, which decodes to the OS
    // account name and the whole directory tree exactly as a Claude Code slug
    // does. Encoding it here is what lets one redaction rule cover both agents.
    expect(byId('fixture-session-a').project).toBe('C--Users-testuser-work-acme-billing');
  });

  it('survives redactProject with the machine-identifying half gone', () => {
    const slug = byId('fixture-session-a').project;
    const shown = redactProject(slug, FIXTURE_HOME);
    expect(shown).toBe('work-acme-billing');
    expect(shown).not.toContain('testuser');
    expect(shown).not.toContain('Users');
  });

  it('redacts a project taken from a turn context the same way', () => {
    expect(redactProject(byId('rollout-2026-09-02T08-00-00-fixture-session-c').project, FIXTURE_HOME)).toBe(
      'scratch',
    );
  });
});

describe('tool attribution', () => {
  const a = byId('fixture-session-a');

  it('attributes tool output bytes through the pending call_id map', () => {
    expect(a.toolBytes.shell).toBe(5); // exec -> "abcde"
    expect(a.toolBytes.files).toBe(2); // apply_patch -> "ok"
    expect(a.toolBytes.connectors).toBe(8); // node_repl/js -> "12345678"
  });

  it('counts an MCP call from mcp_tool_call_end, which is where it appears', () => {
    // Verified on the real corpus: exec + wait + shell_command + apply_patch +
    // view_image + update_plan = 707, exactly the 127 function_call plus 580
    // custom_tool_call lines. MCP calls are entirely outside that set, so
    // counting them here cannot double-count.
    expect(a.connectorCalls['node_repl']).toBe(1);
    expect(a.connectorBytes['node_repl']).toBe(8);
  });

  it('takes patch_apply_end as the file-write signal', () => {
    expect(a.producedFile).toBe(true);
    expect(a.fileWrites).toBe(1);
    expect(byId('fixture-session-b').producedFile).toBe(false);
  });

  it('buckets Codex tool names on their own table', () => {
    // Not classify.ts: that file is a verbatim port of the reference script's
    // Claude Code buckets, and the differential check against it only means
    // anything while it stays verbatim.
    expect(codexCategory('exec')).toBe('shell');
    expect(codexCategory('shell_command')).toBe('shell');
    expect(codexCategory('apply_patch')).toBe('files');
    expect(codexCategory('web_search')).toBe('web');
    expect(codexCategory('mcp__srv__tool')).toBe('connectors');
    expect(codexCategory('update_plan')).toBe('other');
  });
});

describe('malformed and partial rollouts', () => {
  it('reads a rollout whose header was never written', () => {
    const c = byId('rollout-2026-09-02T08-00-00-fixture-session-c');
    // No session_meta, so the id falls back to the filename and the project to
    // the turn context's cwd rather than to the date directory it sits in —
    // which would have labelled every session '02'.
    expect(c.turns).toBe(0);
    expect(c.project).toBe('C--Users-testuser-scratch');
    expect(c.byModel).toEqual([]);
  });

  it('skips a truncated final line without throwing', () => {
    // A rollout is appended to by a live process, so the last line is routinely
    // a partial write. Fixture C ends on one.
    const raw = fs.readFileSync(
      path.join(CODEX, '2026', '09', '02', 'rollout-2026-09-02T08-00-00-fixture-session-c.jsonl'),
      'utf8',
    );
    expect(raw.trimEnd().endsWith('"event_ms')).toBe(true);
    expect(unreadable).toEqual([]);
  });

  it('returns an empty stat for empty text rather than throwing', () => {
    const empty = parseCodexRollout('', { id: 'x', bytes: 0 });
    expect(empty.turns).toBe(0);
    expect(empty.project).toBe('unknown');
    expect(empty.source).toBe('codex');
  });

  it('tags every stat with its source', () => {
    for (const stat of stats) expect(stat.source).toBe('codex');
  });
});

describe('pricing is absent, not folded in as free', () => {
  const report = aggregate(stats, {
    table,
    ttl: '5m',
    cacheWriteMult: cacheWriteMultiplier(table, '5m'),
  });

  it('names every Codex model as unpriced', () => {
    // prices.json carries Anthropic first-party rates and no OpenAI ones. The
    // existing unpriced path counts these and reports them; the HTML report
    // prints "Unpriced models excluded from the total" above the figure.
    expect(report.unpricedModelsSeen).toEqual(['gpt-5.5', 'gpt-5.6-sol']);
  });

  it('counts the tokens and the turns while the dollars stay zero', () => {
    expect(report.turns).toBe(6);
    expect(report.usage.input).toBe(27000);
    expect(report.usage.cacheRead).toBe(30000);
    expect(report.usage.output).toBe(1300);
    // Zero because no rate exists, never because a rate of zero was applied. A
    // guessed OpenAI rate would make this a confident wrong number instead.
    expect(report.cost.total).toBe(0);
  });

  it('charges no startup prefix at a rate that does not exist', () => {
    expect(report.findings.startupPrefixUsd).toBe(0);
  });
});

describe('the per-source summary', () => {
  const rows = summariseSources(stats, table, '5m');

  it('reports Codex tokens beside an honestly blank dollar column', () => {
    expect(rows).toHaveLength(1);
    const codex = rows[0];
    expect(codex?.source).toBe('codex');
    expect(codex?.label).toBe('OpenAI Codex CLI');
    expect(codex?.turns).toBe(6);
    expect(codex?.usd).toBe(0);
    expect(codex?.fullyPriced).toBe(false);
    expect(codex?.unpricedTurns).toBe(6);
    expect(codex?.unpricedModels).toEqual(['gpt-5.5', 'gpt-5.6-sol']);
  });

  it('splits a mixed corpus by the agent that wrote each transcript', () => {
    const claude: SessionStat = {
      file: '',
      project: 'demo',
      id: 'claude-1',
      turns: 2,
      usage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 10 },
      byModel: [
        {
          model: 'claude-opus-5',
          speed: 'standard',
          usage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 10 },
          turns: 2,
        },
      ],
      startupPrefix: 100,
      isSubagent: false,
      toolBytes: {},
      connectorBytes: {},
      connectorCalls: {},
      producedFile: false,
      fileWrites: 0,
      startedAt: null,
      endedAt: null,
      bytes: 10,
      usageRewrites: 0,
      unidentifiedUsage: 0,
      messageIds: [],
    };

    const mixed = summariseSources([claude, ...stats], table, '5m');
    expect(mixed.map((r) => r.source)).toEqual(['claude-code', 'codex']);
    // An untagged stat is a Claude Code stat — which is what every stat was
    // before Codex was read at all.
    expect(mixed[0]?.fullyPriced).toBe(true);
    expect(mixed[0]?.usd).toBeGreaterThan(0);
    expect(mixed[1]?.usd).toBe(0);
  });
});

describe('the CLI flag is opt-in', () => {
  const HOME = 'C:\\Users\\jdoe';

  it('defaults to Claude Code alone, so nothing changes for anyone', () => {
    const o = parseArgs([], HOME);
    expect(o.source).toBe('claude');
    expect(o.codexRoot.endsWith(path.join('.codex', 'sessions'))).toBe(true);
  });

  it('accepts the three selections and their aliases', () => {
    expect(parseArgs(['--source', 'codex'], HOME).source).toBe('codex');
    expect(parseArgs(['--source=all'], HOME).source).toBe('all');
    expect(parseArgs(['--source=both'], HOME).source).toBe('all');
    expect(parseArgs(['--source=claude-code'], HOME).source).toBe('claude');
  });

  it('reports an unrecognised selection instead of silently reading Claude only', () => {
    // "--source codx" quietly reading one agent looks exactly like the other
    // agent contributing nothing.
    const o = parseArgs(['--source', 'codx'], HOME);
    expect(o.unknown).toEqual(['--source codx']);
    expect(o.source).toBe('claude');
  });

  it('keeps the two roots as separate flags', () => {
    const o = parseArgs(['--root', '/a', '--codex-root', '/b'], HOME);
    expect(o.root).toBe(path.resolve('/a'));
    expect(o.codexRoot).toBe(path.resolve('/b'));
    expect(o.unknown).toEqual([]);
  });
});

describe('the browser build constraint', () => {
  it('keeps codex-parse.ts free of Node built-ins', () => {
    // Same rule as parse.ts, for the same reason: the web app runs this exact
    // module on a File the user picked, so one transcript produces one set of
    // numbers on both surfaces. An import of node:fs here breaks that build, and
    // the repair someone reaches for is a second parser — which drifts.
    const src = fs.readFileSync(path.join(root, 'src', 'codex-parse.ts'), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec?.startsWith('node:')).toBe(false);
      expect(spec?.startsWith('./')).toBe(true);
    }
  });
});

/**
 * What the backwards-counter rule actually assumes.
 *
 * The header of `codex-parse.ts` used to justify skipping a backwards counter as
 * "an out-of-order restatement", which is only half the story: a genuine counter
 * RESET is indistinguishable from a restatement at the point of reading, and
 * skipping one silently discards every token spent until the counter climbs back
 * past its old high-water mark.
 *
 * The rule stands anyway, and these tests pin both halves of why so the
 * trade-off is a checked claim rather than a comment nobody re-reads.
 */
describe('a counter that goes backwards', () => {
  function rollout(totals: readonly number[]): SessionStat {
    const lines = [
      JSON.stringify({
        timestamp: '2026-09-01T09:00:00Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5', cwd: '/home/demo/proj' },
      }),
      ...totals.map((t, i) =>
        JSON.stringify({
          timestamp: `2026-09-01T09:${String(i + 1).padStart(2, '0')}:00Z`,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: t,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 0,
                total_tokens: t,
              },
            },
          },
        }),
      ),
    ];
    return parseCodexRollout(`${lines.join('\n')}\n`, { id: 'synthetic', bytes: 0 });
  }

  it('understates a genuine reset rather than risking a double count', () => {
    // 0 -> 60,000 -> 100,000, then the counter restarts and climbs 20,000 ->
    // 30,000. The true spend is 130,000 tokens; this reader says 100,000.
    // That is the accepted loss, and it is accepted because the other reading
    // is far worse: re-basing on 20,000 and then meeting a legitimate 120,000
    // from the ORIGINAL sequence yields a 100,000-token delta for a turn that
    // cost 20,000, roughly doubling the session. Understating is this tool's
    // standing bias; the cache-TTL default is the same choice.
    const reset = rollout([60_000, 100_000, 20_000, 30_000]);
    expect(reset.usage.input).toBe(100_000);
    expect(reset.turns).toBe(2);
    expect(reset.usageRewrites).toBe(2);
  });

  it('holds the invariant the whole design rests on', () => {
    // A session's total is the maximum cumulative counter it ever showed. That
    // is what makes the gate safe against duplicates and reordering in any
    // order, and it is exactly what a reset breaks — so the invariant has to be
    // stated as the thing that is true, not as the thing that is right.
    for (const totals of [
      [10, 20, 30],
      [10, 30, 20, 30],
      [30, 10, 20],
    ]) {
      const stat = rollout(totals);
      expect(stat.usage.input).toBe(Math.max(...totals));
    }
  });
});
