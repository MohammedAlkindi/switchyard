import type { Metadata, Viewport } from 'next';
import { Instrument_Serif, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const serif = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
});

const mono = JetBrains_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const SITE_URL = 'https://contextbill.vercel.app';

export const metadata: Metadata = {
  // Resolves the relative og:image and canonical URLs below. Without it Next
  // emits relative social-card URLs, which no crawler can fetch.
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'contextbill: what your AI agents cost at API rates',
    template: '%s · contextbill',
  },
  description:
    'Read the Claude Code transcripts already on your disk and see what they cost: which sessions ran expensive, which produced nothing, and how much loads before you type a word. Priced at Anthropic API rates.',
  applicationName: 'contextbill',
  authors: [{ name: 'Mohammed Alkindi', url: 'https://github.com/MohammedAlkindi' }],
  creator: 'Mohammed Alkindi',
  keywords: [
    'Claude Code cost',
    'AI agent cost analysis',
    'LLM token spend',
    'prompt cache cost',
    'developer tools',
  ],
  // No `alternates.canonical` here, and no `openGraph.url`. Route metadata is
  // merged down from the root, so a canonical declared here is inherited by
  // every route that does not override it: /_not-found shipped
  // <link rel="canonical" href="https://contextbill.vercel.app"> and told
  // crawlers a 404 was the home page. A canonical URL is per-route by
  // definition, so the root is the wrong place for one. Each route that should
  // have one declares it: / in page.tsx, /privacy, /terms and /login in their
  // own files. Routes that should not have one — the 404, the dashboard — now
  // emit none, which is the correct answer rather than a missing one.
  openGraph: {
    type: 'website',
    siteName: 'contextbill',
    title: 'contextbill: what your AI agents cost at API rates',
    description:
      'Local-first cost analysis for Claude Code. Parsing runs in your browser; only totals are saved.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'contextbill: what your AI agents cost at API rates',
    description:
      'Local-first cost analysis for Claude Code. Parsing runs in your browser; only totals are saved.',
  },
};

// The product is light on every route. Declaring it here means form controls,
// scrollbars and the pre-paint canvas match the stylesheet instead of the OS.
export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#FAFAF9',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
