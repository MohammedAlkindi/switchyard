import { createBrowserClient } from '@supabase/ssr';

/**
 * Supabase client for browser/client components.
 *
 * Uses the PUBLISHABLE key only. That key is designed to be shipped to the
 * browser — it is not a secret, and it grants nothing on its own. Row-level
 * security on every table is what actually protects data, which is why the
 * schema has ownership policies rather than "is authenticated" checks.
 *
 * The service-role key bypasses RLS entirely and must never appear in this
 * app, on the client or the server.
 */
export function createClient() {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];

  if (!url || !key) {
    throw new Error(
      'Supabase environment variables are missing. Copy web/.env.example to ' +
        'web/.env.local and fill in your project URL and publishable key.',
    );
  }

  return createBrowserClient(url, key);
}
