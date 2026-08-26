import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { num, pct, usd, when } from '@/lib/format';

function n(v: string | number | null | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseFloat(v);
  return 0;
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: report, error } = await supabase
    .from('reports')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  // A row belonging to someone else returns null here because row-level
  // security filters it out, so a wrong id and a foreign id look identical.
  if (error || !report) notFound();

  const [{ data: categories }, { data: models }, { data: sessions }] = await Promise.all([
    supabase.from('report_categories').select('*').eq('report_id', id).order('usd', { ascending: false }),
    supabase.from('report_models').select('*').eq('report_id', id).order('usd', { ascending: false }),
    supabase.from('report_sessions').select('*').eq('report_id', id).order('usd', { ascending: false }),
  ]);

  const total = n(report.total_usd);
  const prefixUsd = n(report.startup_prefix_usd);
  const prefixShare = total > 0 ? (100 * prefixUsd) / total : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Report · {when(report.created_at)}</p>
          <h2>{report.label ?? 'Untitled report'}</h2>
        </div>
        <Link className="btn secondary" href="/dashboard">
          All reports
        </Link>
      </div>

      <div className="grid cols-3 gap-block">
        <div className="stat">
          <div className="v">{usd(total)}</div>
          <div className="k">
            across {num(report.turns)} turns in {num(report.session_count)} sessions
          </div>
        </div>
        <div className="stat">
          <div className="v spot">{pct(prefixShare)}</div>
          <div className="k">context loaded before you typed. That cost {usd(prefixUsd)}</div>
        </div>
        <div className="stat">
          <div className="v">{num(report.median_startup_prefix)}</div>
          <div className="k">median pre-input tokens, re-read every turn</div>
        </div>
      </div>

      <div className="stack">
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
                {(categories ?? []).map((c) => (
                  <tr key={c.id}>
                    <td>{c.category}</td>
                    <td className="n">{usd(n(c.usd))}</td>
                    <td className="n">{pct(n(c.share))}</td>
                    <td>
                      <div className="bar">
                        <i
                          className={String(c.category).startsWith('startup') ? 'spot' : undefined}
                          style={{ width: `${Math.min(100, n(c.share))}%` }}
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
          <h3 className="gap-head">By model</h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="n">Cost</th>
                  <th className="n">Share</th>
                  <th className="n">Turns</th>
                </tr>
              </thead>
              <tbody>
                {(models ?? []).map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.model}</td>
                    <td className="n">{usd(n(m.usd))}</td>
                    <td className="n">{pct(n(m.share))}</td>
                    <td className="n">{num(m.turns)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h3 className="gap-sm">Most expensive sessions</h3>
          <p className="hint gap-head">
            &ldquo;No file written&rdquo; asks you to look rather than passing judgement. Read-only
            research is real work.
          </p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Project</th>
                  <th className="n">Turns</th>
                  <th className="n">Cost</th>
                  <th className="n">Per turn</th>
                  <th>Output</th>
                </tr>
              </thead>
              <tbody>
                {(sessions ?? []).map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{String(s.session_id).slice(0, 8)}</td>
                    <td><span className="truncate" title={s.project}>{s.project}</span></td>
                    <td className="n">{num(s.turns)}</td>
                    <td className="n">{usd(n(s.usd))}</td>
                    <td className="n">{usd(n(s.usd_per_turn))}</td>
                    <td>
                      <span className={s.produced_file ? 'tag ok' : 'tag warn'}>
                        {s.produced_file ? 'wrote files' : 'no file written'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="hint">
          Prices from the table dated <strong>{report.price_table_date}</strong>. Cache writes
          billed at the <strong>{report.cache_ttl}</strong> TTL rate. Transcripts do not record
          which was used, so that is an assumption, not a measurement.
          {Array.isArray(report.unpriced_models) && report.unpriced_models.length > 0 && (
            <> Unpriced and excluded from the total: {report.unpriced_models.join(', ')}.</>
          )}
        </p>
      </div>
    </>
  );
}
