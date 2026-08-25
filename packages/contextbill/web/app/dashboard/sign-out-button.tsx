'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await createClient().auth.signOut();
        router.push('/');
        router.refresh();
      }}
      style={{
        background: 'none',
        border: 0,
        padding: 0,
        font: 'inherit',
        fontSize: '.85rem',
        color: 'var(--ink-3)',
        cursor: 'pointer',
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
