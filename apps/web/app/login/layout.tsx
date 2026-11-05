import type { Metadata } from 'next';

/**
 * The page itself is a client component and so cannot export metadata. This
 * layout carries it, and also stops the sign-in form inheriting the home page's
 * canonical URL, which is what it did before this file existed.
 */
export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to contextbill to save reports and track your spend over time.',
  alternates: { canonical: '/login' },
  // A sign-in form has nothing to rank for.
  robots: { index: false, follow: true },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
