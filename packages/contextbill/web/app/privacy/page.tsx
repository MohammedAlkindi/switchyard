import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '../site-chrome';

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    'What contextbill stores, what it never stores, which cookies it sets and who processes your data.',
  alternates: { canonical: '/privacy' },
};

/**
 * Every claim on this page is checkable against the code.
 *
 * The parser is `lib/browser-scan.ts` and runs in the visitor's tab; the only
 * write path is the `save_report` RPC, and the schema it writes into has no
 * column capable of holding free-form text. If either of those changes, this
 * page stops being true and has to change in the same commit.
 */
const UPDATED = 'August 26, 2026';

export default function PrivacyPage() {
  return (
    <div className="landing">
      <SiteHeader />

      <main id="main" className="wrap legal" tabIndex={-1}>
        <p className="eyebrow">Privacy</p>
        <h1>Privacy policy</h1>
        <p className="lede">
          contextbill reads Claude Code transcripts and works out what they cost. The
          transcripts are the sensitive part, so the product is built so they never reach
          us. Last updated {UPDATED}.
        </p>

        <div className="callout">
          <h2>The short version</h2>
          <p>
            Your transcripts are parsed inside your own browser tab. Only the numbers that
            come out the other side are saved: totals, per-model spend, and per-session
            counts. No prompt, no completion, no file content and no raw transcript line is
            ever sent to us, because there is no column in the database that could hold
            one.
          </p>
        </div>

        <h2>What we store</h2>
        <p>When you save a report, these are written to our database and nothing else is:</p>
        <ul>
          <li>
            <strong>Report totals.</strong> Total cost, turn count, session count, the date
            of the price table used, and the cache TTL assumption.
          </li>
          <li>
            <strong>Per-model rows.</strong> A model identifier such as{' '}
            <code className="mono">claude-opus-5</code>, its token counts and its cost.
          </li>
          <li>
            <strong>Per-category rows.</strong> A label such as{' '}
            <code className="mono">browser</code> or <code className="mono">shell</code>{' '}
            and the spend attributed to it.
          </li>
          <li>
            <strong>Per-session rows.</strong> A truncated session identifier, a redacted
            project name, turn counts and cost.
          </li>
          <li>
            <strong>Your report name,</strong> if you give one.
          </li>
          <li>
            <strong>Your account.</strong> Email address, and a password hash if you did
            not use Google. Handled by Supabase Auth; we never see a plaintext password.
          </li>
        </ul>

        <h2>What we never store</h2>
        <ul>
          <li>Prompts, completions, or any message content.</li>
          <li>File contents, diffs, or code from your sessions.</li>
          <li>Tool inputs and outputs.</li>
          <li>Raw transcript files, in whole or in part.</li>
        </ul>
        <p>
          This is enforced by the schema rather than by policy. Across all four tables
          every column is a number, a boolean, a timestamp, a UUID or a short identifier.
          There is no <code className="mono">json</code>, <code className="mono">text</code>{' '}
          blob or attachment column, so there is nowhere for message content to go even by
          mistake.
        </p>

        <h2>Project names are redacted before they are stored</h2>
        <p>
          Claude Code names project folders after their path, so a raw folder name can
          contain your operating system username and your directory layout. contextbill
          strips that before a report is saved. If you want the full paths in a local
          report, the command line tool has a <code className="mono">--show-paths</code>{' '}
          flag; that output stays on your machine.
        </p>

        <h2>Cookies</h2>
        <p>
          contextbill sets one kind of cookie: the session cookie that keeps you signed in,
          issued by Supabase Auth and named <code className="mono">sb-…-auth-token</code>.
          It is strictly necessary, in the sense that the product cannot have accounts
          without it, and it is deleted when you sign out.
        </p>
        <p>
          There are no analytics cookies, no advertising cookies and no third-party
          tracking scripts on this site. That is why you were not asked to accept anything:
          under the GDPR and the ePrivacy Directive, a cookie that is strictly necessary to
          deliver a service the user asked for does not require consent, and a banner
          asking permission for cookies we do not set would be theatre rather than
          protection. If that ever changes, a real consent banner appears here first.
        </p>
        <p>
          Web fonts are served from our own domain. <code className="mono">next/font</code>{' '}
          downloads them at build time, so loading a page does not tell Google you visited.
        </p>

        <h2>Who else processes your data</h2>
        <ul>
          <li>
            <strong>Vercel</strong> hosts the site and processes standard request logs,
            including IP addresses, for delivery and abuse prevention.
          </li>
          <li>
            <strong>Supabase</strong> provides authentication and the Postgres database
            holding the aggregates listed above.
          </li>
          <li>
            <strong>Google</strong> only if you choose to sign in with Google, which shares
            your email address with us so we can identify your account.
          </li>
        </ul>
        <p>Your data is not sold, rented, or shared with anyone else.</p>

        <h2>Who can read your reports</h2>
        <p>
          Only you. Every table is protected by row-level security in Postgres, with
          policies that match rows against the signed-in user. The key shipped to your
          browser is a publishable key with no privileges of its own, so the protection
          does not depend on the application behaving correctly.
        </p>

        <h2>How long it is kept</h2>
        <p>
          Reports are kept until you ask for them to be removed, because the point of
          saving them is to compare a number against the same number next month.
        </p>

        <h2>Your rights</h2>
        <p>
          You can ask for a copy of everything associated with your account, ask for
          corrections, or ask for it to be deleted. Deletion removes your reports and your
          account, and it is not recoverable afterwards.
        </p>
        <p>
          There is no delete button in the dashboard yet. Until there is, open an issue on{' '}
          <a href="https://github.com/MohammedAlkindi/contextbill/issues">GitHub</a> and
          say which account it concerns. If you would rather not have an account at all,
          the command line tool runs the same analysis with no network access and no sign
          in.
        </p>

        <h2>Children</h2>
        <p>
          contextbill is a developer tool and is not directed at children under 13. We do
          not knowingly collect their information.
        </p>

        <h2>Changes</h2>
        <p>
          If this policy changes, the date at the top changes with it. The site is open
          source, so the full history of this page is public in the{' '}
          <a href="https://github.com/MohammedAlkindi/contextbill">repository</a>.
        </p>

        <h2>Contact</h2>
        <p>
          Open an issue on{' '}
          <a href="https://github.com/MohammedAlkindi/contextbill/issues">GitHub</a>. For
          anything you would rather not discuss in public, mark it as such in the issue and
          we will find another channel.
        </p>

        <p className="legal-nav">
          <Link href="/terms">Terms of service</Link> &middot; <Link href="/">Home</Link>
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
