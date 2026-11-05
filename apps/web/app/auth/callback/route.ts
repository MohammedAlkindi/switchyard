import { NextResponse, type NextRequest } from 'next/server';
import { safeRedirectPath } from '@core/safe-path';
import { createClient } from '@/lib/supabase/server';

/**
 * Exchanges an OAuth / email-confirmation code for a session cookie.
 *
 * The `next` parameter rides in the URL and is therefore attacker-controlled,
 * so it goes through `safeRedirectPath` — shared with the CLI package and
 * covered by the root test suite — rather than a local check written twice.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeRedirectPath(searchParams.get('next'), '/dashboard');

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
