/**
 * Display formatting shared by the dashboard views.
 *
 * `usd` deliberately mirrors the CLI's formatter so a figure reads identically
 * in the terminal, the generated HTML report, and the web dashboard.
 */

/**
 * The pricing basis, stated once.
 *
 * Every surface that renders a dollar figure has to say what the figure is,
 * because on a subscription it is not what anyone was charged. Holding the
 * sentence here rather than typing it per page is the same argument as
 * `site-chrome.tsx`: three copies means the next correction reaches one page
 * and the other two keep the old claim.
 */
export const BASIS =
  'Figures are API-equivalent: what this usage would cost at Anthropic API rates. ' +
  'A subscription bills a flat fee instead.';
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
