import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// The font files are checked in under app/fonts: the latin subsets Google Fonts
// serves, under the SIL OFL 1.1 (licenses alongside). next/font/google fetched
// them from Google during every build, and Turbopack fails the build when a font
// URL in Google's CSS contains "&" ("next/font/google queries have exactly one
// entry"). CI hit that on 2026-11-16 with no code change. Local files keep the
// build offline and the same on every run.
const instrumentSerif = localFont({
  src: './fonts/InstrumentSerif-Regular-latin.woff2',
  weight: '400',
  style: 'normal',
  variable: '--font-serif',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
});

// One variable file (wght 400 to 800). Declared as 400 to 500, the two weights
// the stylesheet uses, which is what the Google version declared.
const jetbrainsMono = localFont({
  src: './fonts/JetBrainsMono-latin.woff2',
  weight: '400 500',
  style: 'normal',
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
    <html lang="en" className={`${instrumentSerif.variable} ${jetbrainsMono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
