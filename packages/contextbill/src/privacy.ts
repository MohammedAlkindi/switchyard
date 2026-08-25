/**
 * Redaction for values that end up on screen.
 *
 * contextbill's whole point is that you screenshot the report and send it to
 * someone. That makes anything rendered into it effectively public, and the
 * transcript directory layout is not as harmless as it looks.
 *
 * Claude Code names each project directory after the literal startup cwd, with
 * `:` `\` `/` `.` and `~` all mapped to `-`. So a session started in
 * `C:\Users\jdoe\work\acme-billing` produces the slug
 * `C--Users-jdoe-work-acme-billing`, which decodes back to the user's OS
 * account name and their full directory tree. Rendering that verbatim leaks
 * both into every shared screenshot.
 *
 * The fix keeps the useful half — which project cost the most — and drops the
 * part that identifies the machine.
 */

/** Convert a filesystem path to the slug form Claude Code uses for directories. */
export function homeSlug(home: string): string {
  return home.replace(/[:\\/.~]/g, '-');
}

/**
 * Strip machine-identifying prefixes from a project slug.
 *
 * Prefers an exact match against the real home directory, which is precise.
 * Falls back to a generic `<drive>--Users-<name>-` / `-home-<name>-` pattern so
 * transcripts copied from another machine are still covered.
 */
export function redactProject(slug: string, home: string): string {
  if (slug === '' || slug === 'unknown') return 'unknown';

  const prefix = homeSlug(home);
  if (prefix.length > 0 && slug.startsWith(prefix)) {
    const rest = slug.slice(prefix.length).replace(/^-+/, '');
    return rest === '' ? '(home)' : rest;
  }

  // Backstop for slugs that did not originate on this machine.
  const generic = slug.replace(/^[A-Za-z]?-+(?:Users|home)-[^-]+-?/i, '');
  if (generic !== slug) return generic === '' ? '(home)' : generic;

  // A bare drive root such as `C--`.
  if (/^[A-Za-z]-+$/.test(slug)) return '(drive root)';

  return slug;
}
