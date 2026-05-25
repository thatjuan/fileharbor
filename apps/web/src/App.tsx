import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { DashboardPage } from './pages/DashboardPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { NewReceiveLinkPage } from './pages/NewReceiveLinkPage.js';
import { NewSendLinkPage } from './pages/NewSendLinkPage.js';
import { PublicReceivePage } from './pages/PublicReceivePage.js';
import { PublicSendPage } from './pages/PublicSendPage.js';
import { ReceiveLinkDetailPage } from './pages/ReceiveLinkDetailPage.js';
import { SendLinkDetailPage } from './pages/SendLinkDetailPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { useSession } from './lib/auth-client.js';
import { fetchSetupStatus } from './lib/setup.js';

interface SetupCheck {
  status: 'loading' | 'needs-setup' | 'ready';
}

/**
 * Top-level routing.
 *
 *   - Public routes (`/r/:code`) live OUTSIDE the `RequireAuth` tree. They
 *     render even when setup hasn't been completed — the public face is the
 *     value the operator delivers to external uploaders, and "still setting
 *     up the admin" is not their problem. (If the link doesn't exist yet,
 *     the API answers 404, and the page surfaces it cleanly.)
 *
 *   - Admin routes are gated by `RequireAuth`, which redirects to `/login`
 *     when the session is missing.
 *
 *   - The setup-not-done axis only constrains admin routes: when no user
 *     exists, `/setup` is the only admin-tree path; everything else bounces
 *     there. Public routes are unaffected.
 *
 * `GET /api/setup` is the single source of truth for the setup axis. It
 * always returns 200, so the boot probe can drive routing without falling
 * into a loading/error spiral.
 */
export function App(): JSX.Element {
  const [setup, setSetup] = useState<SetupCheck>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchSetupStatus()
      .then((s) => {
        if (cancelled) return;
        setSetup({ status: s.needsSetup ? 'needs-setup' : 'ready' });
      })
      .catch(() => {
        if (!cancelled) setSetup({ status: 'ready' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (setup.status === 'loading') {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes — always available regardless of admin setup state. */}
        <Route path="/r/:code" element={<PublicReceivePage />} />
        <Route path="/s/:code" element={<PublicSendPage />} />

        {setup.status === 'needs-setup' ? (
          <>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="*" element={<Navigate to="/setup" replace />} />
          </>
        ) : (
          <>
            <Route
              path="/login"
              element={
                <RedirectIfAuthenticated>
                  <LoginPage />
                </RedirectIfAuthenticated>
              }
            />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <DashboardPage />
                </RequireAuth>
              }
            />
            <Route
              path="/links/receive/new"
              element={
                <RequireAuth>
                  <NewReceiveLinkPage />
                </RequireAuth>
              }
            />
            <Route
              path="/links/receive/:id"
              element={
                <RequireAuth>
                  <ReceiveLinkDetailPage />
                </RequireAuth>
              }
            />
            <Route
              path="/links/send/new"
              element={
                <RequireAuth>
                  <NewSendLinkPage />
                </RequireAuth>
              }
            />
            <Route
              path="/links/send/:id"
              element={
                <RequireAuth>
                  <SendLinkDetailPage />
                </RequireAuth>
              }
            />
            {/* `/setup` is sealed once a user exists. Bounce to root, which
                will in turn redirect to /login if unauthenticated. */}
            <Route path="/setup" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
    </BrowserRouter>
  );
}

function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!session?.user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

function RedirectIfAuthenticated({ children }: { children: ReactNode }): JSX.Element {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (session?.user) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
