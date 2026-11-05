/**
 * Same-origin redirect target validation.
 *
 * OAuth and email-confirmation callbacks carry a `next` parameter that says
 * where to send the user once a session exists. That parameter rides in the
 * URL, so an attacker can set it. Redirecting to it unchecked is an open
 * redirect: a crafted link sends a freshly-authenticated user to an external
 * site that can then impersonate the app.
 *
 * Only a single-slash absolute path is accepted. Everything else falls back to
 * the supplied default.
 */
export function safeRedirectPath(raw: string | null | undefined, fallback = '/'): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;

  // Reject anything the URL parser would treat as having an origin.
  // "//evil.com" is protocol-relative and "https://evil.com" is absolute;
  // both start a new origin despite one of them beginning with a slash.
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;

  // "/\evil.com" is treated as protocol-relative by some browsers.
  if (raw.startsWith('/\\')) return fallback;

  // A control character can be used to smuggle a scheme past naive checks.
  if (/[\x00-\x1F]/.test(raw)) return fallback;

  return raw;
}
