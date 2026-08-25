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
      <h2 style={{ marginBottom: '.3rem' }}>
        {mode === 'signup' ? 'Create your account' : 'Sign in'}
      </h2>
      <p style={{ fontSize: '.9rem', marginBottom: '1.4rem' }}>
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
        Continue with Google
      </button>

      <p style={{ fontSize: '.85rem', marginTop: '1.25rem', textAlign: 'center' }}>
        {mode === 'signup' ? 'Already have an account? ' : 'No account yet? '}
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signup' ? 'signin' : 'signup');
            setError(null);
            setInfo(null);
          }}
          style={{
            background: 'none',
            border: 0,
            padding: 0,
            font: 'inherit',
            color: 'var(--ink)',
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
        >
          {mode === 'signup' ? 'Sign in' : 'Create one'}
        </button>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: '2rem 0' }}>
      <div className="wrap-narrow" style={{ width: '100%' }}>
        <p style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <Link href="/" className="brand" style={{ justifyContent: 'center' }}>
            contextbill
          </Link>
        </p>
        <Suspense fallback={<div className="card">Loading…</div>}>
          <AuthForm />
        </Suspense>
        <p className="hint" style={{ textAlign: 'center', marginTop: '1.25rem' }}>
          Your transcripts are parsed in your browser. Only the totals are saved.
        </p>
      </div>
    </main>
  );
}
