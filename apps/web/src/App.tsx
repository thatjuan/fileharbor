import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { DashboardPage } from './pages/DashboardPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { useSession } from './lib/auth-client.js';
import { fetchSetupStatus } from './lib/setup.js';

interface SetupCheck {
  status: 'loading' | 'needs-setup' | 'ready';
}

/**
 * Top-level routing. Three logical states:
 *
 *  - Setup not done → only `/setup` is reachable. Every other path bounces
 *    there. Submitting the form sends the operator to `/login`.
 *  - Setup done, signed out → `/login` is reachable; `/` and `/setup` bounce
 *    to `/login`.
 *  - Setup done, signed in → `/` shows the dashboard; `/login` and `/setup`
 *    bounce back to `/`.
 *
 * `GET /api/setup` is the single source of truth for the first axis. It
 * always returns 200, so we can fetch it on mount without falling into a
 * loading/error spiral.
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
        // If the probe fails for any reason (network, server down) assume
        // the system is ready — that path at least surfaces the real error
        // to the user via the login form, instead of getting stuck on a
        // blank loading screen.
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
