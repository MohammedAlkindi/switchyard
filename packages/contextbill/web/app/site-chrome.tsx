import Link from 'next/link';

/**
 * The header and footer every public page shares: landing, privacy, terms, 404.
 *
 * These were inlined in the landing page and nowhere else, which is how the
 * marketing surface and the rest of the site drifted apart. One component means
 * a link added to the footer appears on every public route.
 *
 * Both are presentational. `signedIn` is a prop rather than a Supabase call so
 * the legal pages and the 404 stay static; only the landing page, which already
 * reads the session for its call to action, passes a real value.
 *
 * The header is the same flat bar the dashboard uses, plus `site-top` to make
 * it stick. It used to be a floating translucent pill, which meant the public
 * pages and the signed-in pages did not look like one product: the seam this
 * codebase has already been burned by once, in a different form.
 */
export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="topbar site-top">
      <div className="wrap">
        <Link href="/" className="brand">
          contextbill
        </Link>
        <nav className="topnav" aria-label="Primary">
          <Link className="nav-anchor" href="/#how">How it works</Link>
          <Link className="nav-anchor" href="/#privacy">Privacy</Link>
          <a href="https://github.com/MohammedAlkindi/contextbill">GitHub</a>
          <Link className="btn secondary" href={signedIn ? '/dashboard' : '/login'}>
            {signedIn ? 'Dashboard' : 'Sign in'}
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  // Rendered at request time on the server, so it never goes stale the way a
  // hardcoded year does.
  const year = new Date().getFullYear();

  return (
    <footer className="site-foot">
      <div className="wrap">
        {/* A link, like the header wordmark. Clicking a logo to get home is a
            reflex, and one that works in the header and does nothing in the
            footer reads as a dead control rather than a decision. */}
        <Link href="/" className="brand">
          contextbill
        </Link>
        <nav className="foot-links" aria-label="Footer">
          <Link href="/#how">How it works</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <a href="https://github.com/MohammedAlkindi/contextbill">GitHub</a>
          <a href="https://www.npmjs.com/package/contextbill">npm</a>
        </nav>
        <span className="foot-note">
          &copy; {year}. Your transcripts never leave your machine.
        </span>
      </div>
    </footer>
  );
}
