import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Exchanges an OAuth / email-confirmation code for a session cookie.
 *
 * The `next` parameter is attacker-influencable (it rides in the URL), so it is
 * accepted only when it is a same-origin absolute path. Without that check this
 * is an open redirect: a crafted link could bounce a freshly-authenticated user
 * to an external site.
 */
function safeNext(raw: string | null): string {
  if (!raw) return '/dashboard';
  // Must be a single-slash absolute path. Rejects "https://evil.com",
  // protocol-relative "//evil.com", and anything with a scheme.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard';
  return raw;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeNext(searchParams.get('next'));

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
