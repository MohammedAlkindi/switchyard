import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SiteFooter } from '../site-chrome';
import SignOutButton from './sign-out-button';

export const metadata = {
  title: 'Reports',
  // robots.txt already disallows /dashboard. This is the per-page belt to
  // that braces, and it travels with the route if the file ever moves.
  robots: { index: false, follow: false },
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Proxy already redirects unauthenticated requests; this is the second gate
  // so a direct render can never leak the shell. Row-level security is the third.
  if (!user) redirect('/login?next=/dashboard');

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <Link href="/dashboard" className="brand">
            contextbill
          </Link>
          <nav className="topnav">
            <Link href="/dashboard">Reports</Link>
            <Link href="/dashboard/new">New report</Link>
            <span className="muted xsmall">
              {user.email}
            </span>
            <SignOutButton />
          </nav>
        </div>
      </header>
      <main id="main" className="wrap app-main" tabIndex={-1}>
        {children}
      </main>
      {/* The same footer the public pages use. This layout rendered a header
          and a main and nothing else, so /privacy and /terms were reachable
          from every route on the site except the three a signed-in user
          actually spends time on — which is the exact drift site-chrome.tsx
          was extracted to prevent, reappearing on the other side of the auth
          boundary. It is presentational and takes no session, so adding it
          here costs nothing. */}
      <SiteFooter />
    </>
  );
}
