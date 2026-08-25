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

export const metadata: Metadata = {
  title: 'contextbill',
  description:
    'Know what your AI agents actually cost. Analyze Claude Code usage and see where your tokens and dollars are going.',
  openGraph: {
    title: 'contextbill',
    description: 'Know what your AI agents actually cost.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
