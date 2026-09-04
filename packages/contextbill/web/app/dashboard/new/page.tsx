'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import priceTable from '@prices';
import { aggregate } from '@core/aggregate';
import { cacheWriteMultiplier } from '@core/cost';
import { homeSlug } from '@core/privacy';
import type { CacheTtl, PriceTable, Report } from '@core/types';
import { scanFiles, type UnreadableFile } from '@/lib/browser-scan';
import { createClient } from '@/lib/supabase/client';
import { BASIS, num, pct, usd } from '@/lib/format';

const TABLE = priceTable as unknown as PriceTable;

/**
 * `webkitdirectory` is not in React's typed attribute set.
 *
 * The `<T>` is required: this augments React's generic `InputHTMLAttributes<T>`,
 * and declaration merging only applies when the type parameters match. ESLint
 * reads it as unused because nothing in the body references it, which is a false
 * positive for an augmentation.
 */
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}

type Stage = 'idle' | 'reading' | 'ready' | 'saving';

export default function NewReportPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [report, setReport] = useState<Report | null>(null);
  const [fileCount, setFileCount] = useState(0);
  const [emptyFiles, setEmptyFiles] = useState(0);
  const [unreadable, setUnreadable] = useState<UnreadableFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState<CacheTtl>('5m');
  const [hot, setHot] = useState(false);

  const handleFiles = useCallback(
    async (files: File[], currentTtl: CacheTtl) => {
      setError(null);
      setReport(null);

      const jsonl = files.filter((f) => f.name.toLowerCase().endsWith('.jsonl'));
      if (jsonl.length === 0) {
        setError('No .jsonl transcripts in that selection. Pick your ~/.claude/projects folder.');
        setStage('idle');
        return;
      }

      setStage('reading');
      setFileCount(jsonl.length);

      try {
        // The home path is unknown in a browser, so redaction falls back to the
        // generic <drive>/Users/<name> pattern inside redactProject.
        const {
          stats,
          emptyFiles: empties,
          unreadable: skipped,
        } = await scanFiles(jsonl, homeSlug(''), (p) =>
          setProgress({ done: p.done, total: p.total }),
        );

        // Every file failing is a different situation from a few failing, and
        // it must not render as a $0.00 report.
        if (stats.length === 0) {
          setError(
            `None of the ${jsonl.length} transcript(s) could be read. ` +
              `The first failure was "${skipped[0]?.reason ?? 'unknown'}". If Claude Code is ` +
              'running, the files are being rewritten as they are read; try again in a moment.',
          );
          setStage('idle');
          return;
        }

        const built = aggregate(stats, {
          table: TABLE,
          ttl: currentTtl,
          cacheWriteMult: cacheWriteMultiplier(TABLE, currentTtl),
          topN: 25,
        });

        if (built.turns === 0) {
          setError(
            `Read ${stats.length} file(s) but found no usage data. That folder may not be a ` +
              'Claude Code transcript root.',
          );
          setStage('idle');
          return;
        }

        setEmptyFiles(empties);
        setUnreadable(skipped);
        setFileCount(stats.length);
        setReport(built);
        setStage('ready');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read those files.');
        setStage('idle');
      }
    },
    [],
  );

  async function save() {
    if (!report) return;
    setStage('saving');
    setError(null);

    try {
      const supabase = createClient();
      const payload = {
        label: label.trim(),
        price_table_date: report.priceTableDate,
        cache_ttl: report.cacheTtlAssumed,
        transcript_count: report.transcriptCount,
        session_count: report.sessionCount,
        turns: report.turns,
        span_days: report.spanDays,
        total_usd: report.cost.total,
        input_usd: report.cost.input,
        cache_write_usd: report.cost.cacheWrite,
        cache_read_usd: report.cost.cacheRead,
        output_usd: report.cost.output,
        median_startup_prefix: report.findings.medianStartupPrefix,
        startup_prefix_usd: report.findings.startupPrefixUsd,
        tok_input: report.usage.input,
        tok_cache_write: report.usage.cacheWrite,
        tok_cache_read: report.usage.cacheRead,
        tok_output: report.usage.output,
        unpriced_models: report.unpricedModelsSeen,
        categories: report.byCategory.map((c) => ({
          category: c.category,
          usd: c.usd,
          share: c.share,
        })),
        models: report.byModel.map((m) => ({
          model: m.model,
          usd: m.usd,
          share: m.share,
          turns: m.turns,
        })),
        sessions: report.topSessions.map((s) => ({
          session_id: s.id.slice(0, 12),
          project: s.project,
          turns: s.turns,
          usd: s.usd,
          usd_per_turn: s.usdPerTurn,
          produced_file: s.producedFile,
          started_at: s.startedAt ? new Date(s.startedAt).toISOString() : null,
        })),
      };

      const { data, error: rpcError } = await supabase.rpc('save_report', { payload });
      if (rpcError) throw rpcError;

      router.push(`/dashboard/${String(data)}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the report.');
      setStage('ready');
    }
  }

  const prefixShare =
    report && report.cost.total > 0
      ? (100 * report.findings.startupPrefixUsd) / report.cost.total
      : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">New report</p>
          <h1 className="page-title">Point it at your transcripts</h1>
        </div>
        <Link className="btn secondary" href="/dashboard">
          Cancel
        </Link>
      </div>

      {error && <div className="notice err">{error}</div>}

      <div className="notice warn">
        Your transcripts are read in this browser tab and never uploaded. Only the
        totals below are saved to your account.
      </div>

      {stage !== 'ready' && stage !== 'saving' && (
        <div
          className={hot ? 'drop hot' : 'drop'}
          onDragOver={(e) => {
            e.preventDefault();
            setHot(true);
          }}
          onDragLeave={() => setHot(false)}
          onDrop={(e) => {
            e.preventDefault();
            setHot(false);
            void handleFiles(Array.from(e.dataTransfer.files), ttl);
          }}
        >
          <h3>Select your transcript folder</h3>
          <p className="center-col gap-top">
            On most machines that is <code className="mono">~/.claude/projects</code>. You can
            also drop <code className="mono">.jsonl</code> files here directly.
          </p>

          <input
            ref={inputRef}
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            accept=".jsonl"
            className="visually-hidden"
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : [];
              void handleFiles(files, ttl);
            }}
          />

          <button
            className="btn"
            type="button"
            disabled={stage === 'reading'}
            onClick={() => inputRef.current?.click()}
          >
            {stage === 'reading' ? 'Reading…' : 'Choose folder'}
          </button>

          {stage === 'reading' && (
            <>
              {/* scaleX, not width. The fill is full width and squashed from
                  the left, so a tick composites instead of re-running layout
                  on a main thread that is already parsing the corpus. Still a
                  data-driven inline style, which is what the design system
                  reserves inline styles for. */}
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}
                aria-label="Transcripts parsed"
              >
                <i
                  style={{
                    transform: `scaleX(${progress.total ? progress.done / progress.total : 0})`,
                  }}
                />
              </div>
              <p className="hint">
                {num(progress.done)} of {num(progress.total)} transcripts parsed
              </p>
            </>
          )}
        </div>
      )}

      {report && unreadable.length > 0 && (
        <div className="notice warn">
          <strong>
            {num(fileCount)} of {num(fileCount + unreadable.length)} transcripts were read.
          </strong>{' '}
          The {num(unreadable.length)} below could not be, so the totals exclude them. This
          normally means a Claude Code session was writing to those files while the browser
          read them.
          <ul className="gap-top">
            {unreadable.slice(0, 5).map((u) => (
              <li key={u.path}>
                <code className="mono">{u.path}</code> — {u.reason}
              </li>
            ))}
          </ul>
          {unreadable.length > 5 && <p className="hint">and {num(unreadable.length - 5)} more.</p>}
        </div>
      )}

      {report && (
        <div className="stack gap-top">
          <div className="grid cols-3">
            <div className="stat">
              <div className="v">{usd(report.cost.total)}</div>
              <div className="k">
                at API rates, across {num(report.turns)} turns in {num(report.sessionCount)}{' '}
                sessions
              </div>
            </div>
            <div className="stat">
              <div className="v spot">{pct(prefixShare)}</div>
              <div className="k">
                of that total was context loaded before you typed, worth{' '}
                {usd(report.findings.startupPrefixUsd)}
              </div>
            </div>
            <div className="stat">
              <div className="v">{num(report.findings.medianStartupPrefix)}</div>
              <div className="k">median pre-input tokens</div>
            </div>
          </div>

          <div className="card">
            <h3 className="gap-head">Where it went</h3>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="n">Cost</th>
                    <th className="n">Share</th>
                    <th className="col-share" />
                  </tr>
                </thead>
                <tbody>
                  {report.byCategory
                    .filter((c) => c.usd > 0)
                    .map((c) => (
                      <tr key={c.category}>
                        <td>{c.category}</td>
                        <td className="n">{usd(c.usd)}</td>
                        <td className="n">{pct(c.share)}</td>
                        <td>
                          <div className="bar">
                            <i
                              className={c.category.startsWith('startup') ? 'spot' : undefined}
                              style={{ width: `${Math.min(100, c.share)}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="field">
              <label htmlFor="label">Label this report (optional)</label>
              <input
                id="label"
                type="text"
                placeholder="e.g. August, or before pruning connectors"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>

            <p className="hint gap-head">{BASIS}</p>

            <p className="hint">
              {num(fileCount)} transcripts read
              {unreadable.length > 0 && ` · ${num(unreadable.length)} could not be read`}
              {emptyFiles > 0 && ` · ${num(emptyFiles)} contained no usage data`} · prices dated{' '}
              {report.priceTableDate} · cache writes billed at the {report.cacheTtlAssumed} rate
              {report.unpricedModelsSeen.length > 0 &&
                ` · unpriced and excluded: ${report.unpricedModelsSeen.join(', ')}`}
            </p>

            <div className="row">
              <button className="btn" type="button" onClick={save} disabled={stage === 'saving'}>
                {stage === 'saving' ? 'Saving…' : 'Save report'}
              </button>
              <button
                className="btn secondary"
                type="button"
                disabled={stage === 'saving'}
                onClick={() => {
                  const nextTtl: CacheTtl = ttl === '5m' ? '1h' : '5m';
                  setTtl(nextTtl);
                  setReport(null);
                  setStage('idle');
                }}
              >
                Recalculate at {ttl === '5m' ? '1h' : '5m'} cache rate
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
