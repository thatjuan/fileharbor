# Goal Analysis — Issue #37: Multipart Upload Support

## Source
- GitHub issue: https://github.com/thatjuan/fileharbor/issues/37
- Title: "Multipart upload support (lift the 100 MB tunnel cap and the 5 GB single-PUT cap)"
- Labels: `enhancement`, `prd:v2`

## North Star
Add a multipart upload protocol that:
1. **S3 backend**: Lifts the 5 GB single-PUT ceiling to S3's native 5 TiB max.
2. **Local backend**: Removes the Cloudflare Tunnel 100 MB body cap by uploading parts (each < cap) instead of one giant PUT.
3. **Both backends**: Adds per-part retry, parallel uploads, and explicit cancel/abort.
4. **No regression** for small files: single-PUT path stays the default below `STORAGE_MULTIPART_THRESHOLD_BYTES` (default 100 MiB).

## Hard Constraints (from issue acceptance criteria)
- 2 GiB upload via `/r/<code>` works in **local mode behind CF Tunnel Free plan**.
- 50 GiB upload works in **S3 mode** (verified at minimum against MinIO in CI).
- Files ≤ `STORAGE_MULTIPART_THRESHOLD_BYTES` keep using single-PUT — multipart adds zero overhead for small uploads.
- Per-part retry recovers from a transient 5xx without restarting the whole upload.
- User-cancel calls abort within 1 s; multipart session disappears from S3 / local parts dir.
- TTL'd sweep aborts abandoned multipart sessions; `aws s3api list-multipart-uploads` is empty after.
- Deleting a parent link mid-upload aborts the multipart session promptly (no leaked S3 charges, no leaked local disk).
- UI progress is continuous and monotonic across parts (no "stuck at 99%").
- Server memory bounded — uploading 50 GiB does NOT grow RSS proportionally. Local concatenation is streaming.
- README documents the multipart threshold, part size, abort behavior, and what happens on cancel/fail/sweep-abort.
- No regression to single-PUT, downloads (Range), DELETE, ticket sweep, send-link bundles, or local-mode signing.

## Existing Surface (relevant code)
- `apps/server/src/storage/index.ts` — `StorageProvider` interface (presignPut/Get/Delete, headObject, deleteObject). New methods land here.
- `apps/server/src/storage/s3.ts` — only AWS SDK importer. Adds `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`. Per-part presign via `getSignedUrl`.
- `apps/server/src/storage/local.ts` — local backend; presigns are HMAC-signed URLs pointing at `/api/storage/o/...`.
- `apps/server/src/storage/signing.ts` — canonical-string HMAC. Needs a multipart-part variant.
- `apps/server/src/routes/storage.ts` — Hono routes for local PUT/GET/DELETE. Adds part-receive route.
- `apps/server/src/db/schema.ts` — `upload_tickets` table. Extends with multipart columns; adds `upload_ticket_parts` table (per planning team's recommendation).
- `apps/server/drizzle/` — six existing SQL migrations. Adds `0006_*` for multipart schema.
- `apps/server/src/tickets/sweep.ts` — current sweep expires pending tickets + deletes terminal. Adds multipart-abort phases.
- `apps/server/src/tickets/upload-tickets.ts` — ticket module. Adds multipart init/complete/abort methods. Keeps single-PUT path untouched for files below threshold.
- `apps/server/src/routes/public-receive-links.ts`, `apps/server/src/routes/public-upload-tickets.ts` — public surface for receive-link uploads. Adds `multipart/init|complete|abort` routes.
- Admin send-link routes (`send-links.ts`) — symmetric multipart endpoints.
- `apps/server/src/config.ts` — adds `STORAGE_MULTIPART_THRESHOLD_BYTES`, `STORAGE_MULTIPART_PART_SIZE_BYTES`, `STORAGE_MULTIPART_TTL_SECONDS` envs.
- `apps/web/src/lib/upload.ts` — extends to switch single-PUT vs multipart on file size.
- `apps/web/src/lib/api.ts` — new typed wrappers for the multipart endpoints.
- `apps/web/src/pages/PublicReceivePage.tsx`, `NewSendLinkPage.tsx`, `SendLinkDetailPage.tsx` — call the new multipart helper; progress aggregation across parts.
- New `/api/config/upload` endpoint — exposes the threshold so the threshold is operator-tunable without rebuilding the frontend.

## Cascade / Lifecycle Subtleties
- Current `upload_tickets.{receive_link_id, send_link_id}` FKs are `ON DELETE CASCADE`. Deleting a link wipes the ticket row, leaving any in-flight S3 multipart session orphaned (S3 charges storage for incomplete parts indefinitely).
- Two strategies considered in the issue:
  - **Soft-delete the ticket** (set status='aborting') in the link-delete code path; sweep handles physical S3/local abort, then deletes the row.
  - **Pre-delete abort hook**: link-delete first enumerates in-flight multipart tickets, aborts them, then proceeds with the existing cascade.
- Planning team decides which; both are workable. The pre-delete hook is simpler and keeps the CASCADE story unchanged.

## Out of Scope (issue-declared)
- Resumability across browser sessions / page reload (needs IndexedDB).
- Multipart download (existing Range GETs are sufficient).
- Frontend chunk-size auto-tuning by observed throughput.
- Pausable uploads.
- Replacing single-PUT with multipart for all uploads (small files stay on single-PUT).

## Execution Model
Plans are executed by coding agents at xhigh effort. Human time/speed/estimate constraints do NOT apply — prefer the most robust, well-engineered option that uses existing project tooling, patterns, and components. Reject options only on risk, security, maintainability, or convention grounds.
