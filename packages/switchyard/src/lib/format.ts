import chalk from 'chalk';
import Table from 'cli-table3';

export function table(head: string[], rows: string[][]): string {
  const t = new Table({
    head: head.map((h) => chalk.bold(h)),
    style: { head: [], border: [] },
    wordWrap: true,
  });
  t.push(...rows);
  return t.toString();
}

/** ANSI clear screen + scrollback + cursor home; used between `fleet watch` frames. */
export const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

export const ok = (msg: string): string => chalk.green(msg);
export const warn = (msg: string): string => chalk.yellow(msg);
export const fail = (msg: string): string => chalk.red(msg);
export const dim = (msg: string): string => chalk.dim(msg);
export const bold = (msg: string): string => chalk.bold(msg);

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** "just now", "5m ago", "3h ago", "2d ago", then a date for anything older. */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 0) return then.toISOString();
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return then.toISOString().slice(0, 10);
}
