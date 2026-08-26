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
        <section className="wrap hero">
          <h1 className="tight enter">Know what your AI agents actually cost.</h1>
          <p className="lede enter">
            Per-seat billing gives you one number a month. contextbill reads the
            transcripts already on your disk and shows you the rest: which sessions
            were expensive, which produced nothing, and how much you pay before you
            type a word.
          </p>
          <div className="row enter">
            <Link className="btn" href={user ? '/dashboard/new' : '/login'}>
              {user ? 'Create a report' : 'Get started free'}
            </Link>
            <a
              className="btn secondary"
              href="https://github.com/MohammedAlkindi/contextbill"
            >
              View the source
            </a>
          </div>
          <p className="hint enter">
            Prefer the terminal? <code className="mono">npx contextbill</code> runs
            offline and uploads nothing.
          </p>
        </section>

        <section className="wrap section" id="how">
          <p className="eyebrow">How it works</p>
          <h2>Four steps. Your transcripts stay on your machine.</h2>
          <div className="grid cols-4">
            <div className="feature">
              <h3>1 &middot; Point it at a folder</h3>
              <p>
                Usually <code className="mono">~/.claude/projects</code>.
              </p>
            </div>
            <div className="feature">
              <h3>2 &middot; Parsing runs in your browser</h3>
              <p>Token counts, model ids and timestamps. Never message content.</p>
            </div>
            <div className="feature">
              <h3>3 &middot; Only totals are saved</h3>
              <p>Aggregates reach the server. Raw transcripts never leave the tab.</p>
            </div>
            <div className="feature">
              <h3>4 &middot; Compare over time</h3>
              <p>Reports are kept so you can watch a number move after you change something.</p>
            </div>
          </div>
        </section>

        <section className="wrap section">
          <p className="eyebrow">The number nobody shows you</p>
          <h2>You pay for the same context on every turn.</h2>
          <p className="lede">
            Every session loads a system prompt, a tool catalog, connector definitions
            and instruction files before doing any work. That block gets written to
            cache once, then re-read on every turn after. A 500-turn session pays for
            it 500 times.
          </p>
          <p className="lede">
            On the machine this was built for, that came to 18.2% of the bill. You
            shrink it by deleting connectors you never call, not by prompting
            differently.
          </p>
        </section>

        <section className="wrap section" id="privacy">
          <p className="eyebrow">Privacy</p>
          <h2>What actually leaves your computer.</h2>
          <div className="grid cols-3">
            <div className="feature">
              <h3>Aggregates only</h3>
              <p>
                Totals, per-model spend and session-level counts. No prompts, no
                completions, no file contents.
              </p>
            </div>
            <div className="feature">
              <h3>Paths are redacted</h3>
              <p>
                Folder names encode your OS username. contextbill strips that before
                anything is stored.
              </p>
            </div>
            <div className="feature">
              <h3>Or skip the account</h3>
              <p>
                The CLI does the same analysis with no network access at all. Same
                engine, same numbers.
              </p>
            </div>
          </div>
        </section>

        <section className="wrap section">
          <h2>See your number in about a minute.</h2>
          <div className="row">
            <Link className="btn" href={user ? '/dashboard/new' : '/login'}>
              {user ? 'Create a report' : 'Get started free'}
            </Link>
            <span className="term">
              <span className="sigil">$</span> npx contextbill
            </span>
          </div>
        </section>
      </main>
    </>
  );
}
