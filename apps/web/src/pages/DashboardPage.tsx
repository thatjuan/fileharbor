import { useNavigate } from 'react-router-dom';

import { signOut, useSession } from '../lib/auth-client.js';

/**
 * Placeholder admin dashboard. Filled out by later slices (#4 storage,
 * #5 tracer). Renders whatever Better Auth's session payload exposes so the
 * operator has visual confirmation that auth is wired end-to-end.
 */
export function DashboardPage(): JSX.Element {
  const { data: session } = useSession();
  const navigate = useNavigate();

  const onSignOut = async (): Promise<void> => {
    await signOut();
    navigate('/login', { replace: true });
  };

  const displayName =
    (session?.user as { displayUsername?: string | null } | undefined)?.displayUsername ??
    (session?.user as { username?: string | null } | undefined)?.username ??
    session?.user?.name ??
    'admin';

  return (
    <main className="page">
      <header className="row between">
        <h1>File Harbor</h1>
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <p>
        Signed in as <strong>{displayName}</strong>.
      </p>
      <p className="muted">Dashboard content lands in upcoming slices.</p>
    </main>
  );
}
