/**
 * Tiny client for the first-run setup endpoint. Lives outside Better Auth's
 * surface because creating the very first user is a privileged, one-time
 * server flow — not a Better Auth API.
 */

export interface SetupStatus {
  needsSetup: boolean;
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch('/api/setup', { credentials: 'include' });
  if (!res.ok) throw new Error(`/api/setup returned ${res.status}`);
  return (await res.json()) as SetupStatus;
}

export interface CreateAdminInput {
  username: string;
  password: string;
  name?: string;
}

export interface CreateAdminError {
  error: string;
  message?: string;
}

export async function createAdmin(input: CreateAdminInput): Promise<void> {
  const res = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'include',
  });
  if (res.ok) return;
  let payload: CreateAdminError;
  try {
    payload = (await res.json()) as CreateAdminError;
  } catch {
    throw new Error(`/api/setup failed with ${res.status}`);
  }
  throw new Error(payload.message ?? payload.error ?? `/api/setup failed with ${res.status}`);
}
