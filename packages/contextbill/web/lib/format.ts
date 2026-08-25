/**
 * Display formatting shared by the dashboard views.
 *
 * `usd` deliberately mirrors the CLI's formatter so a figure reads identically
 * in the terminal, the generated HTML report, and the web dashboard.
 */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function num(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function pct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

export function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
