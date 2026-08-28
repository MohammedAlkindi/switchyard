'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { createClient } from '@/lib/supabase/client';

/**
 * Deleting one saved report.
 *
 * No RPC and no migration: `reports` carries an owner-scoped DELETE policy
 * (`user_id = auth.uid()`), and all three child tables reference it with
 * ON DELETE CASCADE, so removing the parent row removes everything belonging
 * to it. Row-level security is what scopes this, not the id in the URL — a
 * foreign id deletes nothing rather than deleting someone else's report.
 *
 * The confirm step is deliberately a second click rather than a `window.confirm`.
 * The action is irreversible and the dialog is the only thing between a misclick
 * and lost data, so it names what is about to happen instead of asking "are you
 * sure" about an unnamed thing.
 */
export function DeleteReport({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: delError, count } = await supabase
        .from('reports')
        .delete({ count: 'exact' })
        .eq('id', id);

      if (delError) throw delError;

      // RLS filters rather than rejects, so deleting a row you do not own
      // succeeds and removes nothing. Reporting that as done would be a lie.
      if (count === 0) {
        setError('That report could not be deleted. It may already be gone.');
        setBusy(false);
        setArmed(false);
        return;
      }

      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that report.');
      setBusy(false);
    }
  }

  if (!armed) {
    return (
      <div className="stack">
        {error && <div className="notice err">{error}</div>}
        <button className="btn danger" type="button" onClick={() => setArmed(true)}>
          Delete this report
        </button>
      </div>
    );
  }

  return (
    <div className="notice warn">
      <p>
        <strong>Delete {label}?</strong> This removes the saved totals, the per-category,
        per-model and per-session rows, and cannot be undone. Your transcripts are on your
        own disk and are not affected.
      </p>
      <div className="row gap-top">
        <button className="btn danger" type="button" disabled={busy} onClick={() => void remove()}>
          {busy ? 'Deleting…' : 'Yes, delete it'}
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={busy}
          onClick={() => setArmed(false)}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
