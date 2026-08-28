import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '../site-chrome';

export const metadata: Metadata = {
  title: 'Terms',
  description:
    'The terms covering the contextbill hosted service and the MIT-licensed command line tool.',
  alternates: { canonical: '/terms' },
};

const UPDATED = 'August 26, 2026';

export default function TermsPage() {
  return (
    <div className="landing">
      <SiteHeader />

      <main id="main" className="wrap legal" tabIndex={-1}>
        <p className="eyebrow">Terms</p>
        <h1>Terms of service</h1>
        <p className="lede">
          These cover the hosted service at contextbill.vercel.app. The command line tool
          is separate and is covered by its MIT licence. Last updated {UPDATED}.
        </p>

        <h2>What the service is</h2>
        <p>
          contextbill estimates what your Claude Code usage cost, by reading transcripts
          you point it at and pricing them against a published rate table. It is a free
          service provided as is.
        </p>

        <div className="callout">
          <h2>Estimates, not invoices</h2>
          <p>
            Every figure is an estimate produced from your transcripts and a rate table
            with a date on it. It is not a bill, it is not issued by any model provider,
            and it will not match your invoice. Three limits are worth naming, largest
            first. Figures are priced at Anthropic&apos;s published first-party API rates,
            so if you work on a subscription you paid a flat fee and these dollars value
            the usage rather than restate what you were charged; Bedrock and Vertex are
            priced separately again and are not modelled. A transcript records how many
            tokens were written to cache but not which cache lifetime was charged, so
            contextbill assumes the cheaper one and therefore tends to understate. And
            the startup-prefix figure is a model of how a session&apos;s fixed overhead is
            apportioned, not a line item anyone billed you. Do not use these numbers as
            the sole basis for a financial decision, a chargeback or a dispute.
          </p>
        </div>

        <h2>Your account</h2>
        <p>
          You are responsible for keeping your credentials secure and for what happens
          under your account. Tell us if you think it has been compromised. One person or
          organisation per account.
        </p>

        <h2>What you may not do</h2>
        <ul>
          <li>
            Upload anything you do not have the right to analyse, including someone else&apos;s
            transcripts.
          </li>
          <li>
            Try to reach another user&apos;s data, or probe the service for ways to do so. If
            you find one, report it rather than using it.
          </li>
          <li>
            Automate against the service in a way that degrades it for other people.
          </li>
          <li>Use it to break the law, or to breach your agreement with a model provider.</li>
        </ul>

        <h2>Your content</h2>
        <p>
          The aggregates you save stay yours. We do not claim any rights over them and we
          do not use them to train anything. We need permission to store and display them
          back to you, and that is the whole of it.
        </p>

        <h2>Availability</h2>
        <p>
          There is no uptime guarantee. The service may change or stop. Because it is free
          and open source, keep your own copy of anything that matters. The command line
          tool produces the same numbers offline and does not depend on this site existing.
        </p>

        <h2>Liability</h2>
        <p>
          The service is provided without warranties of any kind. To the extent the law
          allows, we are not liable for indirect or consequential loss, or for any decision
          made on the basis of an estimate the service produced. Nothing here limits
          liability that cannot lawfully be limited.
        </p>

        <h2>Ending it</h2>
        <p>
          Stop using the service whenever you like, and ask for your data to be deleted as
          described in the{' '}
          <Link href="/privacy">privacy policy</Link>. We may suspend an account that
          breaks these terms.
        </p>

        <h2>Changes</h2>
        <p>
          If these terms change, the date at the top changes with them, and the history is
          public in the repository.
        </p>

        <h2>Contact</h2>
        <p>
          Open an issue on{' '}
          <a href="https://github.com/MohammedAlkindi/contextbill/issues">GitHub</a>.
        </p>

        <p className="legal-nav">
          <Link href="/privacy">Privacy policy</Link> &middot; <Link href="/">Home</Link>
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
