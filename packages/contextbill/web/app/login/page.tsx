'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

type Mode = 'signin' | 'signup';

const MIN_PASSWORD = 8;

function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/dashboard';

  const [mode, setMode] = useState<Mode>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (mode === 'signup' && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();

      if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
        });
        if (err) throw err;
        // With email confirmation on, there is no session yet.
        if (data.session) {
          router.push(next);
          router.refresh();
        } else {
          setInfo(`Check ${email} for a confirmation link to finish signing up.`);
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        router.push(next);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
      });
      if (err) throw err;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in is unavailable.');
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 className="gap-sm">
        {mode === 'signup' ? 'Create your account' : 'Sign in'}
      </h2>
      <p className="small gap-lede">
        {mode === 'signup'
          ? 'Save reports and track your spend over time.'
          : 'Welcome back.'}
      </p>

      {error && <div className="notice err">{error}</div>}
      {info && <div className="notice ok">{info}</div>}

      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === 'signup' && (
            <p className="hint">Must be at least {MIN_PASSWORD} characters</p>
          )}
        </div>

        {mode === 'signup' && (
          <div className="field">
            <label htmlFor="confirm">Confirm password</label>
            <input
              id="confirm"
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        )}

        <button className="btn full" type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <div className="divider">or</div>

      <button className="btn secondary full" type="button" onClick={onGoogle} disabled={busy}>
        {/* Google's four-colour mark, inlined so the button renders with no
            network request and keeps its own colours in both themes. */}
        <svg className="gmark" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          <path
            fill="#4285F4"
            d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
          />
          <path
            fill="#34A853"
            d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
          />
          <path
            fill="#FBBC05"
            d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
          />
          <path
            fill="#EA4335"
            d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
          />
        </svg>
        Continue with Google
      </button>

      <p className="small gap-top center">
        {mode === 'signup' ? 'Already have an account? ' : 'No account yet? '}
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signup' ? 'signin' : 'signup');
            setError(null);
            setInfo(null);
          }}
          className="linkish"
        >
          {mode === 'signup' ? 'Sign in' : 'Create one'}
        </button>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main id="main" className="auth-page" tabIndex={-1}>
      <div className="wrap-narrow auth-shell">
        <p className="center gap-block">
          <Link href="/" className="brand center">
            contextbill
          </Link>
        </p>
        <Suspense fallback={<div className="card">Loading…</div>}>
          <AuthForm />
        </Suspense>
        <p className="hint center gap-top">
          Your transcripts are parsed in your browser. Only the totals are saved.
        </p>
      </div>
    </main>
  );
}
