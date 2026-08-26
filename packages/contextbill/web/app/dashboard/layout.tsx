import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import SignOutButton from './sign-out-button';

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
    </>
  );
}
