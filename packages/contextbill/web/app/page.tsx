import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { SiteHeader, SiteFooter } from './site-chrome';

/**
 * The home page's own canonical and og:url.
 *
 * These used to live on the root layout, where they were inherited by every
 * route that did not override them — which is how the 404 came to declare
 * itself canonical to the home page. Title and description still come from the
 * root, correctly: those have sensible defaults. A canonical does not.
 */
export const metadata: Metadata = {
  alternates: { canonical: '/' },
  openGraph: { url: '/' },
};

/**
 * Scroll-entry motion, armed by the page itself rather than by the stylesheet.
 *
 * The pre-state (`opacity: 0`) lives behind `[data-motion="on"]`, and only this
 * script sets that attribute. So an environment that blocks scripts, or a
 * visitor who asked for reduced motion, gets the finished page with nothing
 * hidden. That is the failure this project already shipped once: an earlier
 * version hid content in CSS and revealed it with JavaScript, which rendered a
 * near-blank page anywhere the script did not run.
 *
 * It runs at parse time, before any `.reveal` element exists, so the pre-state
 * applies before first paint and there is no flash of visible-then-hidden.
 */
const MOTION_SCRIPT = `(function(){
try{
  var m = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (m && m.matches) return;
  if (!('IntersectionObserver' in window)) return;
  var root = document.documentElement;
  root.setAttribute('data-motion','on');
  var arm = function(){
    try {
      var io = new IntersectionObserver(function(entries){
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            entries[i].target.classList.add('is-in');
            io.unobserve(entries[i].target);
          }
        }
      }, { rootMargin: '0px 0px -12% 0px', threshold: 0 });
      var els = document.querySelectorAll('.reveal');
      for (var j = 0; j < els.length; j++) io.observe(els[j]);
    } catch (e) {
      root.removeAttribute('data-motion');
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm);
  else arm();
}catch(e){}
})();`;

/**
 * The hero visual is the product's argument, drawn as the artifact it describes.
 *
 * Six turns of one session, in a report window. The amber block is the context
 * loaded before you type, identical on every row because it is re-read every
 * turn. The ink block is the work you actually asked for, which varies. Six
 * identical amber blocks say in one glance what the copy takes a paragraph
 * to say.
 *
 * Bar widths and the wipe stagger live in globals.css, keyed off nth-child.
 * They are fixed illustration geometry, not data, and the design system here
 * reserves inline styles for values that actually come from a report. Nothing
 * in this figure is a number, because inventing one would make the page lie.
 */
const TURNS = ['turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5', 'turn 6'];

function HeroLedger() {
  return (
    <figure className="ledger-figure">
      <div
        className="ledger"
        role="img"
        aria-label="Six turns of one session. Every turn is billed for the same fixed block of context before any work happens, roughly a third of each turn, while the work itself varies."
      >
        <div className="ledger-bar">
          <span className="ledger-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="ledger-path">~/.claude/projects</span>
        </div>

        <div className="ledger-body">
          <div className="ledger-head">
            <span className="ledger-title">One session</span>
            <span className="ledger-meta">6 turns</span>
          </div>

          <div className="ledger-rows reveal wipe">
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
      <figcaption className="ledger-cap">The same block, billed on every turn.</figcaption>
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

const STEPS = [
  {
    title: 'Point it at a folder',
    body: 'Usually ~/.claude/projects. Nothing is uploaded to choose it.',
  },
  {
    title: 'Parsing runs in your browser',
    body: 'Token counts, model ids and timestamps. Never message content.',
  },
  {
    title: 'Only totals are saved',
    body: 'Aggregates reach the server. Raw transcripts never leave the tab.',
  },
  {
    title: 'Compare over time',
    body: 'Reports are kept, so you can watch a number move after you change something.',
  },
];

const CLAIMS = [
  {
    term: 'Aggregates only',
    body: 'Totals, per-model spend and session-level counts. No prompts, no completions, no file contents.',
  },
  {
    term: 'Paths redacted',
    body: 'Project folder names encode your OS username. contextbill strips that before anything is stored.',
  },
  {
    term: 'Or no account',
    body: 'The CLI runs the same analysis with no network access at all. Same engine, same numbers.',
  },
];

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
      {/* Runs at parse time so the entrance pre-state applies before paint. */}
      <script dangerouslySetInnerHTML={{ __html: MOTION_SCRIPT }} />
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
            <h1>You pay for the same context on every turn.</h1>
            <p className="lede">
              A system prompt, a tool catalog and your instruction files load before you
              type a word, then get re-read on every turn after the first. contextbill
              prices the transcripts already on your disk.
            </p>
            <div className="row">
              <ArrowCta href={ctaHref}>{ctaLabel}</ArrowCta>
              <a className="btn secondary" href="https://github.com/MohammedAlkindi/contextbill">
                View the source
              </a>
            </div>
          </div>

          <div className="hero-visual reveal">
            <HeroLedger />
          </div>
        </section>

        <section className="wrap section">
          <h2>Where the money actually goes.</h2>
          <div className="figure-split reveal">
            <p className="figure-block">
              <span className="figure-n">21.2%</span>
              <span className="figure-k">
                of the bill on the machine this was built for, measured across 1,884
                transcripts.
              </span>
            </p>
            <div className="figure-prose">
              <p className="lede">
                That share is overhead. It is written to cache once and re-read on every
                turn after it, so a 500-turn session pays for it 500 times. You shrink it
                by deleting connectors you never call, not by prompting differently.
              </p>
              <p>
                contextbill breaks the same total down by model, by session and by what
                each session actually produced, so you can tell an expensive session from
                a wasted one.
              </p>
            </div>
          </div>
          <p className="basis-note">
            Every figure is API-equivalent: what that usage would cost metered at
            Anthropic&apos;s published API rates. On a subscription you paid a flat fee
            instead, so the dollars value the usage rather than restate your invoice.
          </p>
        </section>

        <section className="wrap section" id="how">
          <h2>Four steps, and your transcripts stay on your machine.</h2>
          <div className="steps reveal stagger">
            {STEPS.map((step) => (
              <div className="step" key={step.title}>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="wrap section" id="privacy">
          <h2>What actually leaves your computer.</h2>
          <dl className="claims reveal stagger">
            {CLAIMS.map((claim) => (
              <div className="claim" key={claim.term}>
                <dt>{claim.term}</dt>
                <dd>{claim.body}</dd>
              </div>
            ))}
          </dl>
          <p className="section-more">
            <Link href="/privacy">Read the full privacy policy</Link>
          </p>
        </section>

        <section className="wrap closer reveal">
          <h2>See your number in about a minute.</h2>
          <div className="row">
            <ArrowCta href={ctaHref}>{ctaLabel}</ArrowCta>
            <span className="term">
              <span className="sigil" aria-hidden="true">
                $
              </span>
              <span className="mono">npx contextbill</span>
            </span>
          </div>
          <p className="closer-note">Runs offline and uploads nothing.</p>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
