/**
 * Thin fetch wrappers for the admin + public JSON APIs. Same surface the
 * dashboard uses; a hypothetical CLI would call these endpoints directly.
 *
 * All admin calls go via `credentials: 'include'` so Better Auth's session
 * cookie travels. The public endpoints don't need credentials but it doesn't
 * hurt to pass them (they're ignored server-side).
 */

/**
 * Computed "what would happen if a stranger tried to upload right now?".
 * Server-side, derived from the policy module + state. Don't reproduce the
 * computation client-side — the badge is a switch on this string.
 *
 * `active`            — link is usable.
 * `disabled`          — admin toggled it off.
 * `expired`           — past its `expiresAt`.
 * `quota_exhausted`   — `maxUploads` reached.
 */
export type ReceiveLinkDisplayStatus = 'active' | 'expired' | 'quota_exhausted' | 'disabled';

export interface ReceiveLink {
  id: string;
  code: string;
  label: string;
  /**
   * True iff the link has a password set. The hash itself is never returned by
   * the API; the admin UI only needs the boolean to render a lock icon.
   */
  passwordProtected: boolean;
  maxUploads: number | null;
  /** Unix epoch seconds, UTC. Rendered in viewer-local time by the dashboard. */
  expiresAt: number | null;
  /** Persisted lifecycle flag (admin toggle). */
  status: 'active' | 'disabled';
  /** Policy-derived status for badge rendering. See `ReceiveLinkDisplayStatus`. */
  displayStatus: ReceiveLinkDisplayStatus;
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

/**
 * Same `displayStatus` lexicon the receive side uses. The send link's quota
 * column (`max_downloads`) is the source of `quota_exhausted` here. #8 always
 * persists `null`, so the branch is unreachable until #11.
 */
export type SendLinkDisplayStatus = ReceiveLinkDisplayStatus;

export interface SendLink {
  id: string;
  code: string;
  label: string;
  passwordProtected: boolean;
  maxDownloads: number | null;
  /** Running tally of completed recipient downloads. Always 0 in this slice. */
  downloadCount: number;
  expiresAt: number | null;
  status: 'active' | 'disabled';
  displayStatus: SendLinkDisplayStatus;
  createdAt: number;
}

/**
 * Public face of a send link, returned by `GET /api/public/send-links/:code`.
 * Internal ids (link id, s3 keys) are deliberately omitted; file ids are
 * surfaced because the recipient needs them to request a download ticket.
 */
export interface PublicSendLinkFile {
  id: string;
  filename: string;
  size: number;
  contentType: string;
}

export interface PublicSendLink {
  label: string;
  passwordRequired: boolean;
  status: 'ok';
  /** Admin-configured cap on recipient downloads, or null when unlimited. */
  maxDownloads: number | null;
  /**
   * Pre-computed "remaining slots" for UI rendering. Clamped at 0, null when
   * `maxDownloads` is null (unlimited). The `downloadCount` itself is not
   * exposed — the recipient doesn't need to see how often the link was hit.
   */
  remainingDownloads: number | null;
  /** Unix epoch seconds, UTC. Null when no expiry was set. */
  expiresAt: number | null;
  files: PublicSendLinkFile[];
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

export interface CreateReceiveLinkInput {
  label: string;
  /** Plaintext. Hashed server-side. Empty / undefined = no password. */
  password?: string | null;
  /** Positive integer. Undefined / null = unlimited. */
  maxUploads?: number | null;
  /** Unix epoch seconds, UTC. Undefined / null = never. */
  expiresAt?: number | null;
}

export async function createReceiveLink(input: CreateReceiveLinkInput): Promise<ReceiveLink> {
  const res = await fetch('/api/receive-links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
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
): Promise<{ link: ReceiveLink; files: FileRecord[]; uploadsSoFar: number }> {
  const res = await fetch(`/api/receive-links/${encodeURIComponent(id)}`, {
    credentials: 'include',
  });
  return jsonOrThrow<{ link: ReceiveLink; files: FileRecord[]; uploadsSoFar: number }>(res);
}

/**
 * Toggle a link's lifecycle flag. The server returns the updated row;
 * `displayStatus` is recomputed from policy at the same time.
 */
export async function updateReceiveLinkStatus(
  id: string,
  status: 'active' | 'disabled',
): Promise<ReceiveLink> {
  const res = await fetch(`/api/receive-links/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
    credentials: 'include',
  });
  const data = await jsonOrThrow<{ link: ReceiveLink }>(res);
  return data.link;
}

/**
 * Delete a receive link. The link's received files survive — the FK is
 * `ON DELETE SET NULL`, so they become orphans accessible via `/api/files/:id`.
 */
export async function deleteReceiveLink(id: string): Promise<void> {
  const res = await fetch(`/api/receive-links/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok && res.status !== 204) {
    await jsonOrThrow<unknown>(res);
  }
}

export interface FileDownloadResponse {
  url: string;
  /** ISO 8601 expiry of the presigned URL. */
  expiresAt: string;
  filename: string;
  size: number;
  contentType: string;
}

/**
 * Mint a presigned GET for an admin download. The returned `url` is opened
 * directly by the browser (navigation / `<a download>`); File Harbor never
 * proxies the bytes.
 */
export async function getFileDownload(id: string): Promise<FileDownloadResponse> {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}/download`, {
    credentials: 'include',
  });
  return jsonOrThrow<FileDownloadResponse>(res);
}

/** Delete a received file. S3 object first, then DB row. */
export async function deleteFile(id: string): Promise<void> {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok && res.status !== 204) {
    await jsonOrThrow<unknown>(res);
  }
}

// ---------- Admin: send links --------------------------------------------

/**
 * Body shape for `POST /api/send-links`. As of #11 the create call is
 * file-less — the link is created first, then files are added one at a time
 * via `addFileToSendLink`. Mirrors `CreateReceiveLinkInput` for the policy
 * fields.
 */
export interface CreateSendLinkInput {
  label: string;
  /** Plaintext. Hashed server-side. Empty / undefined = no password. */
  password?: string | null;
  /** Positive integer. Undefined / null = unlimited. */
  maxDownloads?: number | null;
  /** Unix epoch seconds, UTC. Undefined / null = never. */
  expiresAt?: number | null;
}

export async function createSendLink(input: CreateSendLinkInput): Promise<SendLink> {
  const res = await fetch('/api/send-links', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'include',
  });
  const data = await jsonOrThrow<{ link: SendLink }>(res);
  return data.link;
}

export interface AddFileToSendLinkInput {
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Mint an upload-ticket for an additional file bound to `sendLinkId`. The
 * admin then PUTs to `ticket.presignedPutUrl` and calls
 * `finalizeUploadTicket(ticketId)` to confirm bytes landed. Used by both the
 * new-link page (looping over the admin's picked files) and the detail page
 * ("add another file" affordance — kept for #12+).
 */
export async function addFileToSendLink(
  sendLinkId: string,
  input: AddFileToSendLinkInput,
): Promise<UploadTicketResponse> {
  const res = await fetch(`/api/send-links/${encodeURIComponent(sendLinkId)}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'include',
  });
  const data = await jsonOrThrow<{ ticket: UploadTicketResponse }>(res);
  return data.ticket;
}

export async function listSendLinks(): Promise<SendLink[]> {
  const res = await fetch('/api/send-links', { credentials: 'include' });
  const data = await jsonOrThrow<{ links: SendLink[] }>(res);
  return data.links;
}

export async function getSendLink(
  id: string,
): Promise<{ link: SendLink; files: FileRecord[] }> {
  const res = await fetch(`/api/send-links/${encodeURIComponent(id)}`, {
    credentials: 'include',
  });
  return jsonOrThrow<{ link: SendLink; files: FileRecord[] }>(res);
}

/**
 * Toggle a send link's lifecycle flag. The server returns the updated row;
 * `displayStatus` is recomputed from policy at the same time. Mirrors
 * `updateReceiveLinkStatus`.
 */
export async function updateSendLinkStatus(
  id: string,
  status: 'active' | 'disabled',
): Promise<SendLink> {
  const res = await fetch(`/api/send-links/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
    credentials: 'include',
  });
  const data = await jsonOrThrow<{ link: SendLink }>(res);
  return data.link;
}

/**
 * Delete a send link. The link's bundled files survive — the FK is
 * `ON DELETE SET NULL`, so they become orphans accessible via
 * `/api/files/:id`. Outstanding download / upload tickets cascade-delete
 * with the link.
 */
export async function deleteSendLink(id: string): Promise<void> {
  const res = await fetch(`/api/send-links/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok && res.status !== 204) {
    await jsonOrThrow<unknown>(res);
  }
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

/**
 * Policy rejection codes returned by the public upload-ticket + finalize
 * endpoints. The same string set the server's `ReceiveLinkPolicyResult.kind`
 * uses, minus `ok` (which would be the success path).
 */
export type PolicyRejection =
  | 'disabled'
  | 'expired'
  | 'quota_exhausted'
  | 'password_required'
  | 'password_wrong';

const POLICY_REJECTIONS: readonly PolicyRejection[] = [
  'disabled',
  'expired',
  'quota_exhausted',
  'password_required',
  'password_wrong',
];

export type CreateUploadTicketOutcome =
  | { kind: 'ok'; value: UploadTicketResponse }
  | { kind: 'policy_rejected'; reason: PolicyRejection }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

/**
 * Helper: parse a Hono 4xx error body of shape `{ error: "<code>" }` and
 * route the well-known policy-rejection codes into the caller's discriminated
 * outcome. Anything else falls into the generic `error` arm.
 */
async function readErrorBody(res: Response): Promise<{ error: string; message?: string }> {
  try {
    return (await res.json()) as { error: string; message?: string };
  } catch {
    return { error: `${res.status}`, message: res.statusText };
  }
}

function asPolicyRejection(code: string): PolicyRejection | null {
  return (POLICY_REJECTIONS as readonly string[]).includes(code) ? (code as PolicyRejection) : null;
}

export async function createUploadTicket(
  code: string,
  payload: { filename: string; contentType: string; size: number; password?: string | null },
): Promise<CreateUploadTicketOutcome> {
  const res = await fetch(`/api/public/receive-links/${encodeURIComponent(code)}/upload-tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    const value = (await res.json()) as UploadTicketResponse;
    return { kind: 'ok', value };
  }
  const body = await readErrorBody(res);
  if (res.status === 404) return { kind: 'not_found' };
  const rejection = asPolicyRejection(body.error);
  if (rejection) return { kind: 'policy_rejected', reason: rejection };
  return { kind: 'error', message: body.message ?? body.error ?? `${res.status}` };
}

export interface FinalizeResponse {
  status: 'completed' | 'failed';
  reason?: string;
}

export type FinalizeOutcome =
  | { kind: 'ok'; value: FinalizeResponse }
  | { kind: 'policy_rejected'; reason: PolicyRejection }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export async function finalizeUploadTicket(
  ticketId: string,
  password?: string | null,
): Promise<FinalizeOutcome> {
  // Always send a JSON body — the public route accepts an empty body, but
  // sending `{ password }` (even when undefined → omitted) is the consistent
  // shape and means the same code path covers both flows.
  const body: Record<string, unknown> = {};
  if (password !== undefined && password !== null && password.length > 0) {
    body.password = password;
  }
  const res = await fetch(`/api/public/upload-tickets/${encodeURIComponent(ticketId)}/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const value = (await res.json()) as FinalizeResponse;
    return { kind: 'ok', value };
  }
  const errBody = await readErrorBody(res);
  if (res.status === 404) return { kind: 'not_found' };
  const rejection = asPolicyRejection(errBody.error);
  if (rejection) return { kind: 'policy_rejected', reason: rejection };
  return { kind: 'error', message: errBody.message ?? errBody.error ?? `${res.status}` };
}

// ---------- Public: send links -------------------------------------------

export async function getPublicSendLink(code: string): Promise<PublicSendLink> {
  const res = await fetch(`/api/public/send-links/${encodeURIComponent(code)}`);
  return jsonOrThrow<PublicSendLink>(res);
}

export interface DownloadTicketResponse {
  ticketId: string;
  presignedGetUrl: string;
  expiresAt: string;
}

export type CreateDownloadTicketOutcome =
  | { kind: 'ok'; value: DownloadTicketResponse }
  | { kind: 'policy_rejected'; reason: PolicyRejection }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

/**
 * Mint a download ticket for a public send link. The returned
 * `presignedGetUrl` is a short-lived S3 GET; the recipient page navigates to
 * it directly to trigger the download (Content-Disposition is set so the
 * browser saves with the friendly filename).
 */
export async function createDownloadTicket(
  code: string,
  payload: { fileId: string; password?: string | null },
): Promise<CreateDownloadTicketOutcome> {
  const res = await fetch(`/api/public/send-links/${encodeURIComponent(code)}/download-tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    const value = (await res.json()) as DownloadTicketResponse;
    return { kind: 'ok', value };
  }
  const body = await readErrorBody(res);
  if (res.status === 404) return { kind: 'not_found' };
  const rejection = asPolicyRejection(body.error);
  if (rejection) return { kind: 'policy_rejected', reason: rejection };
  return { kind: 'error', message: body.message ?? body.error ?? `${res.status}` };
}

/**
 * Fire-and-forget confirm. Tells the server "I just kicked off the presigned
 * GET; please burn one quota slot and mark this ticket completed". Idempotent;
 * the server is happy to receive duplicates. We don't await the result on the
 * caller's critical path — the public download page hits this immediately
 * after handing the URL to the browser and continues regardless of the
 * response (the eventual-expiry sweep is the safety net).
 *
 * `outcome: 'failed'` is the explicit "the user cancelled" signal; it marks
 * the ticket failed WITHOUT consuming a quota slot.
 */
export async function confirmDownloadTicket(
  ticketId: string,
  outcome: 'completed' | 'failed' = 'completed',
): Promise<void> {
  const body = outcome === 'failed' ? JSON.stringify({ outcome: 'failed' }) : '';
  try {
    await fetch(`/api/public/download-tickets/${encodeURIComponent(ticketId)}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // `keepalive` lets the request survive a navigation-away. Same shape
      // that analytics beacons use; relevant here because the page may be
      // unloading as the browser fetches the presigned GET URL.
      keepalive: true,
    });
  } catch {
    // Swallow — the sweep will catch unconfirmed pendings.
  }
}
