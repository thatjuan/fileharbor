/**
 * Thin fetch wrappers for the admin + public JSON APIs. Same surface the
 * dashboard uses; a hypothetical CLI would call these endpoints directly.
 *
 * All admin calls go via `credentials: 'include'` so Better Auth's session
 * cookie travels. The public endpoints don't need credentials but it doesn't
 * hurt to pass them (they're ignored server-side).
 */

export interface ReceiveLink {
  id: string;
  code: string;
  label: string;
  passwordHash: string | null;
  maxUploads: number | null;
  expiresAt: number | null;
  status: 'active' | 'disabled';
  createdAt: number;
}

export interface FileRecord {
  id: string;
  s3Key: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  receiveLinkId: string | null;
  sendLinkId: string | null;
}

export interface PublicReceiveLink {
  label: string;
  passwordRequired: boolean;
  status: 'ok';
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.message ?? body.error ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// ---------- Admin ---------------------------------------------------------

export async function createReceiveLink(label: string): Promise<ReceiveLink> {
  const res = await fetch('/api/receive-links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
    credentials: 'include',
  });
  const data = await jsonOrThrow<{ link: ReceiveLink }>(res);
  return data.link;
}

export async function listReceiveLinks(): Promise<ReceiveLink[]> {
  const res = await fetch('/api/receive-links', { credentials: 'include' });
  const data = await jsonOrThrow<{ links: ReceiveLink[] }>(res);
  return data.links;
}

export async function getReceiveLink(
  id: string,
): Promise<{ link: ReceiveLink; files: FileRecord[] }> {
  const res = await fetch(`/api/receive-links/${encodeURIComponent(id)}`, {
    credentials: 'include',
  });
  return jsonOrThrow<{ link: ReceiveLink; files: FileRecord[] }>(res);
}

// ---------- Public --------------------------------------------------------

export async function getPublicReceiveLink(code: string): Promise<PublicReceiveLink> {
  const res = await fetch(`/api/public/receive-links/${encodeURIComponent(code)}`);
  return jsonOrThrow<PublicReceiveLink>(res);
}

export interface UploadTicketResponse {
  ticketId: string;
  presignedPutUrl: string;
  expiresAt: string;
}

export async function createUploadTicket(
  code: string,
  payload: { filename: string; contentType: string; size: number },
): Promise<UploadTicketResponse> {
  const res = await fetch(`/api/public/receive-links/${encodeURIComponent(code)}/upload-tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return jsonOrThrow<UploadTicketResponse>(res);
}

export interface FinalizeResponse {
  status: 'completed' | 'failed';
  reason?: string;
}

export async function finalizeUploadTicket(ticketId: string): Promise<FinalizeResponse> {
  const res = await fetch(`/api/public/upload-tickets/${encodeURIComponent(ticketId)}/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return jsonOrThrow<FinalizeResponse>(res);
}
