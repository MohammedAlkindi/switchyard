import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { BASIS, num, pct, usd, when } from '@/lib/format';

interface ReportRow {
  id: string;
  created_at: string;
  label: string | null;
  turns: number;
  session_count: number;
  total_usd: string | number;
  startup_prefix_usd: string | number;
  median_startup_prefix: number;
  price_table_date: string;
  cache_ttl: string;
}

/** Postgres numeric arrives as a string over the wire; never trust it as a number. */
function n(v: string | number | null | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseFloat(v);
  return 0;
}

export default async function DashboardPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('reports')
    .select(
      'id, created_at, label, turns, session_count, total_usd, startup_prefix_usd, median_startup_prefix, price_table_date, cache_ttl',
    )
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    return (
      <>
        {/* Every branch of this page needs its own h1: a route that renders
            only an error box has no heading at all, and "the page failed" is
            still a page. */}
        <div className="page-head">
          <div>
            <p className="eyebrow">Reports</p>
            <h1 className="page-title">Something went wrong</h1>
          </div>
        </div>
        <div className="notice err">Could not load reports: {error.message}</div>
      </>
    );
  }

  const reports = (data ?? []) as ReportRow[];

  if (reports.length === 0) {
    return (
      <div className="card empty">
        <h1>No reports yet</h1>
        <p className="narrow-col">
          Point contextbill at your Claude Code transcripts and it will work out what
          they cost. Parsing happens in this browser. Only the totals are saved.
        </p>
        <Link className="btn" href="/dashboard/new">
          Create your first report
        </Link>
      </div>
    );
  }

  const latest = reports[0]!;
  const prefixShare =
    n(latest.total_usd) > 0 ? (100 * n(latest.startup_prefix_usd)) / n(latest.total_usd) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Latest report</p>
          <h1 className="page-title">{when(latest.created_at)}</h1>
        </div>
        <Link className="btn" href="/dashboard/new">
          New report
        </Link>
      </div>

      <div className="grid cols-3 gap-block">
        <div className="stat">
          <div className="v">{usd(n(latest.total_usd))}</div>
          <div className="k">
            at API rates, across {num(latest.turns)} turns in {num(latest.session_count)} sessions
          </div>
        </div>
        <div className="stat">
          <div className="v spot">{pct(prefixShare)}</div>
          <div className="k">
            of that total was context loaded before you typed, worth{' '}
            {usd(n(latest.startup_prefix_usd))}
          </div>
        </div>
        <div className="stat">
          <div className="v">{num(latest.median_startup_prefix)}</div>
          <div className="k">median tokens loaded before your first keystroke</div>
        </div>
      </div>

      <p className="hint">{BASIS}</p>

      <div className="card">
        <h3 className="gap-head">All reports</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Label</th>
                <th className="n">Sessions</th>
                <th className="n">Turns</th>
                <th className="n">Total</th>
                <th className="n">Fixed context</th>
                <th>Prices</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/dashboard/${r.id}`}>{when(r.created_at)}</Link>
                  </td>
                  <td><span className="truncate" title={r.label ?? undefined}>{r.label ?? <span className="muted">Untitled report</span>}</span></td>
                  <td className="n">{num(r.session_count)}</td>
                  <td className="n">{num(r.turns)}</td>
                  <td className="n">{usd(n(r.total_usd))}</td>
                  <td className="n">{usd(n(r.startup_prefix_usd))}</td>
                  <td>
                    <span className="tag">{r.price_table_date}</span>{' '}
                    <span className="tag">{r.cache_ttl}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
