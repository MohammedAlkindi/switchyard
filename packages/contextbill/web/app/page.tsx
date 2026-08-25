import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <span className="brand">contextbill</span>
          <nav className="topnav">
            <a href="#how">How it works</a>
            <a href="#privacy">Privacy</a>
            <a href="https://github.com/MohammedAlkindi/contextbill">GitHub</a>
            <Link className="btn secondary" href={user ? '/dashboard' : '/login'}>
              {user ? 'Dashboard' : 'Sign in'}
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="wrap" style={{ paddingTop: 'clamp(3rem,8vw,6rem)' }}>
          <h1 style={{ maxWidth: '17ch' }}>
            Know what your AI agents actually cost.
          </h1>
          <p style={{ fontSize: '1.1rem', maxWidth: '36rem', margin: '1.25rem 0 2rem' }}>
            Analyze Claude Code usage and see where your tokens and dollars are going —
            including the costs a per-seat dashboard cannot show you.
          </p>
          <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
            <Link className="btn" href={user ? '/dashboard/new' : '/login'}>
              {user ? 'Create a report' : 'Get started free'}
            </Link>
            <a className="btn secondary" href="https://github.com/MohammedAlkindi/contextbill">
              View the source
            </a>
          </div>
          <p className="hint" style={{ marginTop: '1.25rem' }}>
            Or run it entirely offline: <code className="mono">npx contextbill</code>
          </p>
        </section>

        <section className="wrap section" id="how" style={{ marginTop: '3rem' }}>
          <p className="eyebrow">How it works</p>
          <h2 style={{ marginBottom: '1.5rem' }}>Four steps. Your transcripts never upload.</h2>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(14rem,1fr))' }}>
            <div>
              <h3 style={{ fontSize: '.95rem', fontFamily: 'var(--sans)', fontWeight: 600 }}>
                1 · Point it at a folder
              </h3>
              <p style={{ fontSize: '.88rem', margin: '.35rem 0 0' }}>
                Usually <code className="mono">~/.claude/projects</code>.
              </p>
            </div>
            <div>
              <h3 style={{ fontSize: '.95rem', fontFamily: 'var(--sans)', fontWeight: 600 }}>
                2 · Parsed in your browser
              </h3>
              <p style={{ fontSize: '.88rem', margin: '.35rem 0 0' }}>
                Files are read in the tab. No transcript is transmitted.
              </p>
            </div>
            <div>
              <h3 style={{ fontSize: '.95rem', fontFamily: 'var(--sans)', fontWeight: 600 }}>
                3 · Priced against a dated table
              </h3>
              <p style={{ fontSize: '.88rem', margin: '.35rem 0 0' }}>
                Per model, including fast-mode rates.
              </p>
            </div>
            <div>
              <h3 style={{ fontSize: '.95rem', fontFamily: 'var(--sans)', fontWeight: 600 }}>
                4 · Totals saved to your account
              </h3>
              <p style={{ fontSize: '.88rem', margin: '.35rem 0 0' }}>
                Track spend across reports over time.
              </p>
            </div>
          </div>
        </section>

        <section className="wrap section" id="privacy">
          <p className="eyebrow">What is stored</p>
          <h2 style={{ marginBottom: '1rem' }}>Aggregates, never conversations.</h2>
          <p style={{ maxWidth: '38rem' }}>
            contextbill parses transcripts in your browser and sends only derived totals —
            token counts, costs, session identifiers and category sums. There is deliberately
            no column in the database that could hold message content, and directory names are
            redacted before they leave the tab because they encode your OS username.
          </p>
          <p style={{ maxWidth: '38rem', marginTop: '1rem' }}>
            The command-line version does not talk to a network at all. If you would rather
            keep everything on your machine, use that instead — it produces the same numbers
            from the same code.
          </p>
        </section>
      </main>

      <footer className="wrap" style={{ borderTop: '1px solid var(--hair)', padding: '2rem 0 3rem', fontSize: '.82rem' }}>
        <p className="muted">
          contextbill — MIT licensed. Built by{' '}
          <a href="https://github.com/MohammedAlkindi">Mohammed Alkindi</a>.
        </p>
      </footer>
    </>
  );
}
