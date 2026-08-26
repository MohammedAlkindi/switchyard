import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { SiteHeader, SiteFooter } from './site-chrome';

/**
 * The hero visual is the product's argument, drawn.
 *
 * Six turns of one session. The amber block is the context loaded before you
 * type, identical on every row because it is re-read every turn. The dark block
 * is the work you actually asked for, which varies. Six identical amber bars
 * say in one glance what the copy below takes a paragraph to say.
 *
 * Bar widths and the reveal stagger live in globals.css, keyed off nth-child.
 * They are fixed illustration geometry, not data, and the design system here
 * reserves inline styles for values that actually come from a report.
 */
const TURNS = ['turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5', 'turn 6'];

function HeroLedger() {
  return (
    <figure className="ledger-figure">
      <div className="ledger-shell">
        <div
          className="ledger"
          role="img"
          aria-label="Six turns of one session. Every turn is billed for the same fixed block of context before any work happens, roughly a third of each turn, while the work itself varies."
        >
          <div className="ledger-head">
            <span className="ledger-title">One session</span>
            <span className="ledger-meta">6 turns</span>
          </div>

          <div className="ledger-rows">
            {TURNS.map((label) => (
              <div className="ledger-row" key={label}>
                <span className="ledger-label">{label}</span>
                <span className="ledger-track">
                  <span className="seg fixed" />
                  <span className="seg work" />
                </span>
              </div>
            ))}
          </div>

          <div className="ledger-legend">
            <span className="key">
              <i className="dot fixed" />
              context you never typed
            </span>
            <span className="key">
              <i className="dot work" />
              the work you asked for
            </span>
          </div>
        </div>
      </div>
      <figcaption className="ledger-cap">The same block, billed six times.</figcaption>
    </figure>
  );
}

/**
 * Structured data for the home page. Kept minimal and factual: a crawler that
 * believes an aggregateRating we invented is worse than one that reads nothing.
 */
const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'contextbill',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Windows, Linux',
  description:
    'Local-first cost analysis for Claude Code. Reads transcripts already on your disk and reports what they cost.',
  url: 'https://contextbill.vercel.app',
  softwareHelp: 'https://github.com/MohammedAlkindi/contextbill',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  author: { '@type': 'Person', name: 'Mohammed Alkindi' },
};

function ArrowCta({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link className="btn cta" href={href}>
      <span>{children}</span>
      <span className="cta-orb" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 13 13 3M6 3h7v7" />
        </svg>
      </span>
    </Link>
  );
}

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const ctaHref = user ? '/dashboard/new' : '/login';
  const ctaLabel = user ? 'Create a report' : 'Get started free';

  return (
    <div className="landing">
      <script
        type="application/ld+json"
        // The payload is a literal defined above, so there is no user input in it.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />
      <SiteHeader signedIn={Boolean(user)} />

      <main id="main" tabIndex={-1}>
        <section className="wrap hero-split">
          <div className="hero-copy reveal">
            <span className="hero-tag">Local-first cost analysis</span>
            <h1 className="tight">Know what your AI agents actually cost.</h1>
            <p className="lede">
              Per-seat billing gives you one number a month. contextbill reads the
              transcripts already on your disk and shows you the rest: which sessions ran
              expensive, which produced nothing, and how much you pay before you type a
              word.
            </p>
            <div className="row">
              <ArrowCta href={ctaHref}>{ctaLabel}</ArrowCta>
              <a className="btn secondary" href="https://github.com/MohammedAlkindi/contextbill">
                View the source
              </a>
            </div>
            <p className="hint">
              Prefer the terminal? <code className="mono">npx contextbill</code> runs
              offline and uploads nothing.
            </p>
          </div>

          <div className="hero-visual reveal">
            <HeroLedger />
          </div>
        </section>

        <section className="wrap section" id="how">
          <p className="eyebrow">How it works</p>
          <h2>Four steps, and your transcripts stay on your machine.</h2>
          <div className="grid cols-4 reveal">
            <div className="feature">
              <h3>Point it at a folder</h3>
              <p>
                Usually <code className="mono">~/.claude/projects</code>.
              </p>
            </div>
            <div className="feature">
              <h3>Parsing runs in your browser</h3>
              <p>Token counts, model ids and timestamps. Never message content.</p>
            </div>
            <div className="feature">
              <h3>Only totals are saved</h3>
              <p>Aggregates reach the server. Raw transcripts never leave the tab.</p>
            </div>
            <div className="feature">
              <h3>Compare over time</h3>
              <p>Reports are kept, so you can watch a number move after you change something.</p>
            </div>
          </div>
        </section>

        <section className="wrap section">
          <p className="eyebrow">The number nobody shows you</p>
          <h2>You pay for the same context on every turn.</h2>
          <div className="split-prose reveal">
            <p className="lede">
              Every session loads a system prompt, a tool catalog, connector definitions
              and instruction files before doing any work. That block is written to cache
              once, then re-read on every turn after it. A 500-turn session pays for it
              500 times.
            </p>
            <div className="figure-stat">
              <span className="figure-n">18.2%</span>
              <span className="figure-k">
                of the bill on the machine this was built for, measured across 947
                transcripts. You shrink it by deleting connectors you never call, not by
                prompting differently.
              </span>
            </div>
          </div>
        </section>

        <section className="wrap section" id="privacy">
          <p className="eyebrow">Privacy</p>
          <h2>What actually leaves your computer.</h2>
          <div className="grid cols-3 reveal">
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
                The CLI does the same analysis with no network access at all. Same engine,
                same numbers.
              </p>
            </div>
          </div>
          <p className="section-more">
            <Link href="/privacy">Read the full privacy policy</Link>
          </p>
        </section>

        <section className="wrap closer reveal">
          <h2>See your number in about a minute.</h2>
          <div className="row">
            <ArrowCta href={ctaHref}>{ctaLabel}</ArrowCta>
            <span className="term">
              <span className="sigil">$</span> npx contextbill
            </span>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
