import { createAuthClient } from 'better-auth/react';
import { usernameClient } from 'better-auth/client/plugins';

/**
 * Better Auth client. In dev the Vite proxy forwards `/api/*` to the Hono
 * server, so we leave `baseURL` unset and let Better Auth use a same-origin
 * request — works in dev (Vite proxy) and in prod (Hono serves the SPA).
 */
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});

export const { useSession, signIn, signOut } = authClient;
