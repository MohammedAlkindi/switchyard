import type { Metadata } from 'next';

// The page is a client component and cannot export metadata itself.
export const metadata: Metadata = { title: 'New report' };

export default function NewReportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
