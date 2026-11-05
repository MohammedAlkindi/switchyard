import Link from 'next/link';
import { SiteHeader, SiteFooter } from './site-chrome';

export const metadata = {
  title: 'Page not found',
  // No `robots` key. Next emits <meta name="robots" content="noindex"> for
  // this route on its own, so declaring one here produced two conflicting
  // robots tags in _not-found.html — and a crawler reading two is entitled to
  // take the more restrictive. `noindex` alone already implies follow, so
  // dropping ours loses nothing and leaves exactly one tag.
};

export default function NotFound() {
  return (
    <div className="landing">
      <SiteHeader />

      <main id="main" className="wrap notfound" tabIndex={-1}>
        <p className="eyebrow">404</p>
        <h1 className="tight">This page does not exist.</h1>
        <p className="lede">
          The link may be out of date, or the address may have a typo in it. Everything
          below still works.
        </p>
        <div className="row">
          <Link className="btn" href="/">
            Back to the home page
          </Link>
          <Link className="btn secondary" href="/dashboard">
            Go to your dashboard
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
