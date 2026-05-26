# Storage Provider Layer + HTTP Wire Protocol — Issue #37

Scope: the `StorageProvider` interface extension, S3 and local backend
implementations, the HTTP routes that surround them, the canonical-string
extension to `signing.ts`, security model, part-size/concurrency policy, and
the edge-case state machine.

Out of scope for this doc (other planning agents): DB schema (`upload_tickets`
columns, the optional `upload_ticket_parts` table), `upload-tickets` module
state machine, sweep changes, frontend logic.

---

## 1. `StorageProvider` interface extension

File: `apps/server/src/storage/index.ts`. Extend — do not subclass, do not add
a parallel interface.

```ts
export interface StorageProvider {
  // ... existing fields (bucket, defaultTtlSeconds, presignPut, presignGet,
  // presignDelete, headObject, deleteObject)

  /**
   * Open a new multipart upload session for `key`. Returns the provider's
   * uploadId (opaque to the caller) and the server-chosen `partSize` for the
   * session. `partSize` is computed from policy (see §6); the caller does NOT
   * propose it. Both backends persist enough state at this point that
   * `presignUploadPart`, `completeMultipart`, and `abortMultipart` are
   * callable using only `(key, uploadId)` thereafter.
   */
  initMultipart(key: string, opts: InitMultipartOptions): Promise<InitMultipartResult>;

  /**
   * Mint a presigned URL that uploads exactly one part. The provider chooses
   * the Content-Length to sign for this part: every part except the last is
   * exactly `partSize`; the last part is `sizeHint - (partCount - 1) * partSize`.
   * The caller MUST NOT pass `contentLength` — it is server-derived from the
   * init session and the part number.
   */
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    opts?: PresignUploadPartOptions,
  ): Promise<PresignedUrl>;

  /**
   * Finalize a multipart session. `parts` MUST be in ascending `partNumber`
   * order with no gaps starting from 1. The returned `etag` is the storage
   * provider's final object etag: for S3 the SDK-returned multipart etag
   * (e.g. `"abc...-N"`, quoted), for local backend a hex sha256 with no
   * quoting. Callers treat the value as opaque (`ObjectInfo.etag` is already
   * typed `string | null`).
   */
  completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<CompleteMultipartResult>;

  /**
   * Cancel a multipart session. Idempotent at the provider layer: an unknown
   * uploadId resolves successfully. (S3 `AbortMultipartUpload` on a missing
   * upload returns 404; the local backend's parts-dir removal swallows
   * ENOENT.) Calling abort after complete also resolves successfully — the
   * provider has no state left to free.
   */
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export interface InitMultipartOptions {
  /** Total expected bytes for the final object. Required; drives part-size
   * resolution and per-part Content-Length signing for the last part. */
  sizeHint: number;
  /** Required: written into the local-backend `meta.json` sidecar and passed
   * to S3 as `ContentType` on `CreateMultipartUpload`. */
  contentType: string;
}

export interface InitMultipartResult {
  uploadId: string;
  /** Bytes per part. The caller uses this to compute `partCount =
   * ceil(sizeHint / partSize)` and to slice the file on the frontend. */
  partSize: number;
}

export interface PresignUploadPartOptions {
  /** Override the provider default TTL for this single URL (seconds). */
  expiresInSeconds?: number;
}

export interface CompletedPart {
  partNumber: number;
  /** S3 returns this in the `UploadPart` response header; the local backend
   * returns it in the part-PUT response body. */
  etag: string;
}

export interface CompleteMultipartResult {
  /** Opaque to callers. Stored on the file row if the caller wants. */
  etag: string;
}
```

Notes:

- `initMultipart` rejects `sizeHint <= 0`. Zero-byte files always use
  single-PUT — multipart with zero parts is meaningless.
- `presignUploadPart` deliberately omits a `contentLength` field on its opts.
  Allowing the caller to set it would let a buggy ticket-module mint a
  signature for the wrong byte count and silently truncate. The provider
  derives it from session state (which the provider holds: in S3 via the
  remembered partSize from init, in local via `meta.json`).
- All new methods sit alongside `presignPut` etc. in the same interface so
  the rest of the codebase keeps talking to one seam.

---

## 2. S3 backend implementation

File: `apps/server/src/storage/s3.ts`. Add to the existing
`createS3StorageProvider` returned object — same module, same client.

New SDK imports (extend the existing destructured import from
`@aws-sdk/client-s3`):

```ts
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  // ... existing commands
} from '@aws-sdk/client-s3';
```

Session state is kept in-memory on the provider so subsequent calls can
recover the chosen `partSize` (S3 itself does not echo it back). A small
`Map<uploadId, { partSize: number; sizeHint: number }>` lives in the closure
returned by `createS3StorageProvider`. The map IS lost on process restart;
that's acceptable because (a) `presignUploadPart` can also derive partSize
from `sizeHint` recomputed by the caller from the ticket row, and (b) we
also persist `partSize` on the ticket row (DB-team concern), so the provider
can be re-primed from the DB on restart. (Implementation detail: the
ticket module is the authoritative store; the in-memory map is a hot-path
optimisation. `presignUploadPart` accepts an internal fallback path where
partSize is re-derived from `sizeHint` passed alongside, but the public
shape stays clean by having the caller re-call `initMultipart` only on
provider miss. Simpler: require the caller to keep partSize on the ticket
and reseed the provider's map on `presignUploadPart` if absent — see the
ticket-module agent.)

### 2.1 `initMultipart`

```ts
async initMultipart(key, opts) {
  const partSize = resolvePartSize(opts.sizeHint, config.multipartPartSizeBytes);
  const res = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: opts.contentType,
    }),
  );
  const uploadId = res.UploadId;
  if (!uploadId) {
    throw new Error(
      `S3 CreateMultipartUpload returned no UploadId for key=${JSON.stringify(key)}`,
    );
  }
  sessions.set(uploadId, { partSize, sizeHint: opts.sizeHint });
  return { uploadId, partSize };
}
```

`resolvePartSize` is the policy in §6: `Math.max(minPartSize,
Math.ceil(sizeHint / 10_000))`, where `minPartSize` is
`STORAGE_MULTIPART_PART_SIZE_BYTES` (default `16 * 1024 * 1024`). The
`ceil(/10_000)` term enforces the 10 000-part S3 ceiling; partSize never
falls below 5 MiB because the env-var default is already 16 MiB and the
config parser clamps to `>= 5 * 1024 * 1024`.

### 2.2 `presignUploadPart`

```ts
async presignUploadPart(key, uploadId, partNumber, opts) {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new Error(`partNumber out of range: ${partNumber}`);
  }
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return signWithTtl(command, ttlFor(opts?.expiresInSeconds));
}
```

Notes:

- We do NOT sign `ContentLength` into the part presign on S3. S3's SigV4
  presign for `UploadPart` covers the URL parameters
  (`partNumber`/`uploadId`) and the method; Content-Length is enforced by
  the bucket through standard request handling, and signing it makes the
  presign rejection mode opaque. The eventual server-side enforcement that
  matters (truncation guard) is at `CompleteMultipartUpload` time when S3
  validates part sizes against the 5 MiB minimum (except last).
- The same `signWithTtl` helper used by `presignPut`/`presignGet`/
  `presignDelete` works unchanged.

### 2.3 `completeMultipart`

```ts
async completeMultipart(key, uploadId, parts) {
  // Defensive: the caller is responsible for ordering, but a stray
  // out-of-order entry would cause S3 to reject the whole upload. Sort
  // ascending here so the contract holds even if the caller forgot.
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const res = await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: sorted.map((p) => ({
          PartNumber: p.partNumber,
          ETag: p.etag,
        })),
      },
    }),
  );
  // aws-sdk-js v3 surfaces most S3 "200 with <Error>" bodies as thrown
  // errors via the deserialisation middleware — but only when the shape
  // is recognised. Belt-and-braces: a successful response MUST have a
  // populated ETag. A "200 with empty body" indicates the upload did not
  // assemble; treat as failure.
  if (!res.ETag) {
    throw new Error(
      `S3 CompleteMultipartUpload returned 200 with no ETag for key=${JSON.stringify(
        key,
      )} uploadId=${uploadId} — treating as failure.`,
    );
  }
  sessions.delete(uploadId);
  return { etag: res.ETag };
}
```

Error shapes the caller must distinguish (these propagate as thrown errors
with `$metadata.httpStatusCode`):

- `404 NoSuchUpload` — upload was already aborted (sweep, cascade, or
  parallel client). Caller surfaces as `ticket_not_found` / `aborted`.
- `400 InvalidPart` / `400 InvalidPartOrder` — the parts list disagrees
  with what S3 actually received. Caller surfaces as `invalid_parts`.
- `400 EntityTooSmall` — a non-last part smaller than 5 MiB. Caller
  surfaces as `invalid_parts` (or `part_too_small` for log clarity).

### 2.4 `abortMultipart`

```ts
async abortMultipart(key, uploadId) {
  try {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  } catch (err: unknown) {
    if (errorHttpStatus(err) === 404) {
      // NoSuchUpload — already aborted or never existed. Idempotent.
    } else {
      throw err;
    }
  } finally {
    sessions.delete(uploadId);
  }
}
```

`errorHttpStatus` already exists in `s3.ts` and handles the same status
extraction used by `isNotFoundError`.

---

## 3. Local backend implementation

File: `apps/server/src/storage/local.ts`. Extend the existing
`createLocalStorageProvider` returned object. Reuse `mintUrl` patterns and
`resolveSafe`.

### 3.1 On-disk layout

```
${objectsDir}/.multipart/<uploadId>/
  meta.json                        # session metadata, atomic temp-then-rename
  <partNumber>.part                # one file per uploaded part
  <partNumber>.part.meta.json      # per-part {etag, size} sidecar
```

The `.multipart` directory lives under `objectsDir` so the existing
verifyLocalStorage probe already proves write access. A leading dot keeps
it out of the way of the `<receive|send>/<linkId>/...` namespace — a key
starting with `.multipart` would be rejected by `validateKey` (no `.`
segments), so user data and multipart scratch cannot collide.

`meta.json` shape (written once at init):

```json
{
  "key": "receive/<linkId>/<ticketId>/<filename>",
  "partSize": 16777216,
  "expectedParts": 128,
  "contentType": "application/pdf",
  "sizeHint": 2147483648,
  "createdAt": 1716737000
}
```

This is the storage provider's source of truth. The HTTP route that
receives part PUTs reads `meta.json` to recover the bound key and the
per-part `Content-Length` to enforce. The storage layer never reaches into
the DB; the DB-team's ticket row is a parallel record for sweep/UX, not
for the storage layer's correctness.

### 3.2 `uploadId` format

`randomUUID().replace(/-/g, '')` — 32 hex chars, 128 bits of entropy.

Justification: the codebase already uses `randomUUID()` for ticket ids
(`tickets/upload-tickets.ts:165`, `tickets/download-tickets.ts:192`). No
ULID dependency exists in `apps/server/package.json`. Adding a ULID lib to
get monotonicity would introduce a parallel pattern with no concrete
benefit — the parts dir is keyed by uploadId, not browsed in chronological
order, and sweep queries the DB (which has its own `created_at`). The
hyphen-stripped form keeps the path component short and free of any
character that could collide with the parts-dir directory separator. The
character class is also a strict subset of what `validateKey` would
accept, simplifying defensive validation in the part-PUT route.

### 3.3 `initMultipart`

```ts
async initMultipart(key, opts) {
  if (!validateKey(key)) {
    throw new Error(`invalid storage key for local backend: ${JSON.stringify(key)}`);
  }
  if (!Number.isInteger(opts.sizeHint) || opts.sizeHint <= 0) {
    throw new Error(`initMultipart requires positive integer sizeHint`);
  }
  const partSize = resolvePartSize(opts.sizeHint, config.multipartPartSizeBytes);
  const expectedParts = Math.ceil(opts.sizeHint / partSize);
  const uploadId = randomUUID().replace(/-/g, '');
  const sessionDir = join(objectsDir, '.multipart', uploadId);
  await fs.mkdir(sessionDir, { recursive: true });

  const meta = {
    key,
    partSize,
    expectedParts,
    contentType: opts.contentType,
    sizeHint: opts.sizeHint,
    createdAt: Math.floor(Date.now() / 1000),
  };
  // Atomic write-then-rename so a crash mid-write doesn't leave a torn JSON.
  const metaTmp = join(sessionDir, `meta.json.tmp-${randomBytes(8).toString('hex')}`);
  await fs.writeFile(metaTmp, JSON.stringify(meta));
  await fs.rename(metaTmp, join(sessionDir, 'meta.json'));

  return { uploadId, partSize };
}
```

### 3.4 `presignUploadPart`

The presigned URL points at the new local-backend route:

```
PUT /api/storage/o/multipart/part/<uploadId>/<partNumber>?exp=...&cl=...&sig=...
```

There is no `key` in the URL — the route recovers `key` from
`<uploadId>/meta.json`. The canonical that's signed DOES include the key
(see §3.5) so the signature is bound to the session's resolved target.

Per-part Content-Length is server-derived:

- Parts `1..expectedParts-1`: exactly `partSize`.
- Part `expectedParts` (last): `sizeHint - (expectedParts - 1) * partSize`.

The presign reads `meta.json` to compute this:

```ts
async presignUploadPart(key, uploadId, partNumber, opts) {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new Error(`invalid uploadId`);
  }
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new Error(`partNumber out of range: ${partNumber}`);
  }
  const sessionDir = join(objectsDir, '.multipart', uploadId);
  const metaRaw = await fs.readFile(join(sessionDir, 'meta.json'), 'utf8');
  const meta = JSON.parse(metaRaw) as MultipartMeta;
  if (meta.key !== key) {
    throw new Error(`uploadId does not belong to key=${JSON.stringify(key)}`);
  }
  if (partNumber > meta.expectedParts) {
    throw new Error(`partNumber ${partNumber} exceeds expectedParts ${meta.expectedParts}`);
  }
  const partContentLength =
    partNumber === meta.expectedParts
      ? meta.sizeHint - (meta.expectedParts - 1) * meta.partSize
      : meta.partSize;

  const exp = Math.floor(Date.now() / 1000) + ttlFor(opts?.expiresInSeconds);
  const sig = signCanonical(
    {
      method: 'PUT-PART',
      key,
      exp,
      contentLength: partContentLength,
      uploadId,
      partNumber,
    },
    secret,
  );
  const q = new URLSearchParams();
  q.set('exp', String(exp));
  q.set('cl', String(partContentLength));
  q.set('sig', sig);
  const url = `/api/storage/o/multipart/part/${uploadId}/${partNumber}?${q.toString()}`;
  return { url, expiresAt: new Date(exp * 1000) };
}
```

`UPLOAD_ID_PATTERN` is `/^[a-f0-9]{32}$/`, matching the hex form. This is
the defensive validator used by both presign and route handlers.

### 3.5 Canonical-string extension (`signing.ts`)

Extend `CanonicalMethod` and `CanonicalParams` so multipart-part URLs use a
distinct, non-collidable canonical. New file shape:

```ts
export type CanonicalMethod = 'PUT' | 'GET' | 'DELETE' | 'PUT-PART';

export interface CanonicalParams {
  method: CanonicalMethod;
  key: string;
  exp: number;
  contentType?: string;
  contentLength?: number;
  responseContentDisposition?: string;
  /** Set only when method === 'PUT-PART'. */
  uploadId?: string;
  /** Set only when method === 'PUT-PART'. */
  partNumber?: number;
}

function canonical(p: CanonicalParams): string {
  return [
    p.method,
    p.key,
    String(p.exp),
    p.contentType ?? '',
    p.contentLength !== undefined ? String(p.contentLength) : '',
    p.responseContentDisposition ?? '',
    p.uploadId ?? '',
    p.partNumber !== undefined ? String(p.partNumber) : '',
  ].join('\n');
}
```

Properties this gives us:

- `PUT-PART` is a distinct method literal in line 1 of the canonical,
  so an attacker cannot reuse a part PUT URL as a `PUT /put/<key>` —
  even though the path layout differs, the canonical itself diverges in
  line 1, and the route handler verifies the canonical with `method`
  hardcoded per route.
- Existing `PUT`/`GET`/`DELETE` signatures get two extra empty lines at
  the end of their canonical. This is a backward-incompatible signature
  change for already-minted URLs. That's acceptable: the existing presign
  TTL caps at 7 days; in practice URLs in flight at deploy time are
  measured in minutes. If we want zero-downtime URL validity, the verifier
  can probe both forms and accept either during a deploy window — but the
  task constraints (no parallel patterns) and the short TTL make a
  single-form rollover preferable.
- `uploadId` and `partNumber` are positional and unambiguous; an attacker
  who pastes a uploadId/partNumber into a non-multipart URL gets `''`/`''`
  on the verifier side, which does not match the signature.

### 3.6 `completeMultipart`

Streaming concatenation with sha256 computed in the same pass. NO
`Buffer.concat`; NO parallel reads. Target is built at a temp path and
atomically renamed at the end so a crash mid-concat never leaves a
truncated object at the final key.

```ts
async completeMultipart(key, uploadId, parts) {
  if (!validateKey(key)) throw new Error(`invalid key`);
  if (!UPLOAD_ID_PATTERN.test(uploadId)) throw new Error(`invalid uploadId`);
  const sessionDir = join(objectsDir, '.multipart', uploadId);
  const meta = JSON.parse(
    await fs.readFile(join(sessionDir, 'meta.json'), 'utf8'),
  ) as MultipartMeta;
  if (meta.key !== key) {
    throw new Error(`uploadId does not belong to key=${JSON.stringify(key)}`);
  }

  // Validate the parts list: ascending 1..N, no gaps, count matches.
  if (parts.length !== meta.expectedParts) {
    throw new Error(
      `part count mismatch: got ${parts.length}, expected ${meta.expectedParts}`,
    );
  }
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].partNumber !== i + 1) {
      throw new Error(`part list has gap or duplicate at index ${i}`);
    }
  }

  const targetPath = resolveSafe(objectsDir, key);
  if (targetPath === null) throw new Error(`invalid key resolution`);
  await fs.mkdir(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${randomBytes(8).toString('hex')}`;

  const hash = createHash('sha256');
  let totalBytes = 0;
  const writeHandle = await fs.open(tmpPath, 'w');
  try {
    for (const p of sorted) {
      const partPath = join(sessionDir, `${p.partNumber}.part`);
      const stat = await fs.stat(partPath);
      const expectedLen =
        p.partNumber === meta.expectedParts
          ? meta.sizeHint - (meta.expectedParts - 1) * meta.partSize
          : meta.partSize;
      if (stat.size !== expectedLen) {
        throw new Error(
          `part ${p.partNumber} size mismatch: ${stat.size} != ${expectedLen}`,
        );
      }
      // Sequential pipe. `fs.createReadStream` -> `for await` chunks ->
      // hash + write through the open handle. NOT pipeline()'d into a
      // WriteStream wrapping the handle (same WriteStream/handle deadlock
      // documented in routes/storage.ts:81-91).
      const reader = createReadStream(partPath);
      for await (const chunk of reader) {
        const buf = chunk as Buffer;
        hash.update(buf);
        await writeHandle.write(buf);
        totalBytes += buf.byteLength;
      }
    }
    if (totalBytes !== meta.sizeHint) {
      throw new Error(
        `total bytes ${totalBytes} != sizeHint ${meta.sizeHint}`,
      );
    }
    await writeHandle.sync();
  } finally {
    await writeHandle.close().catch(() => {});
  }

  // Atomic rename onto the final key. fs.rename is atomic on POSIX when
  // src and dst share a filesystem (they always do — both under objectsDir).
  await fs.rename(tmpPath, targetPath);

  // Final etag is hex sha256 — matches what the single-PUT route writes
  // (routes/storage.ts:135) so `headObject` returns a consistent encoding
  // regardless of which path put the bytes there.
  const etag = hash.digest('hex');
  const sidecar = {
    contentType: meta.contentType,
    etag,
    size: totalBytes,
  };
  try {
    await fs.writeFile(`${targetPath}.meta.json`, JSON.stringify(sidecar));
  } catch (err) {
    console.warn('[storage] multipart meta sidecar write failed', { key, err });
  }

  // Remove the session dir; failure here is logged, not fatal — sweep
  // handles orphaned `.multipart/*` dirs as a backstop.
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[storage] multipart session cleanup failed', { uploadId, err });
  }

  return { etag };
}
```

Note: the caller's `parts[].etag` values are not strictly required by the
local backend — sha256 is recomputed during concatenation — but accepting
them keeps the interface symmetric with S3 and lets the ticket-module
agent decide whether to verify per-part etags against what was returned
by the part-PUT route. (The route response body returns
`{ etag: "<hex sha256>" }`; cross-checking is cheap.)

### 3.7 `abortMultipart`

```ts
async abortMultipart(key, uploadId) {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) return;
  const sessionDir = join(objectsDir, '.multipart', uploadId);
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
  } catch (err: unknown) {
    if (!isEnoent(err)) throw err;
  }
}
```

`force: true` makes `rm` swallow ENOENT itself, but the explicit catch is
kept as belt-and-braces because some Node minor versions have surfaced
ENOENT here historically. `key` is accepted for interface symmetry; the
local backend does not need it because the session dir is keyed only by
uploadId.

---

## 4. HTTP wire protocol

All endpoints are JSON in / JSON out. Pre-existing patterns from
`routes/public-receive-links.ts`, `routes/public-upload-tickets.ts`, and
`routes/send-links.ts` apply: 400 for invalid input, 404 for unknown
ticket/link, 403 for policy rejection, 200 for ok.

### 4.1 Public receive-link multipart endpoints

Mounted alongside the existing `POST /api/public/receive-links/:code/upload-tickets`.

#### `POST /api/public/receive-links/:code/upload/multipart/init`

Request body:

```json
{
  "filename": "movie.mp4",
  "contentType": "video/mp4",
  "size": 2147483648,
  "password": "..."
}
```

Response body (200):

```json
{
  "ticketId": "f9b3...",
  "uploadId": "1a2b3c4d...",
  "partSize": 16777216,
  "partCount": 128,
  "parts": [
    { "partNumber": 1, "url": "...", "expiresAt": "2026-05-26T12:34:56Z" },
    { "partNumber": 2, "url": "...", "expiresAt": "2026-05-26T12:34:56Z" }
  ],
  "partsRemaining": 28,
  "completeUrl": "/api/public/upload-tickets/<ticketId>/upload/multipart/complete",
  "abortUrl": "/api/public/upload-tickets/<ticketId>/upload/multipart/abort",
  "nextPartsUrl": "/api/public/upload-tickets/<ticketId>/upload/multipart/parts?from=101&to=128"
}
```

Error responses mirror the single-PUT path: `not_found`, `invalid_input`,
`policy_rejected` (`password_required`, `password_wrong`, etc.).

Inline part-URL batch size: **first 100 parts inline**. If `partCount <=
100`, `partsRemaining=0` and `nextPartsUrl` is omitted. Otherwise the
client paginates via `nextPartsUrl` (see §4.4).

Rationale for 100: a single presigned URL is ~700–1500 bytes; 100 inline
= ~100 KB response, fits a single request comfortably without bloating
the init round-trip. The 10 000-part worst case is 100 batches of 100 —
all cheap follow-up GETs that are themselves under 100 KB each.
Batches-on-demand also means later batches get fresh presign TTLs, so a
50 GiB upload that takes longer than `presignTtlSeconds` to complete its
first 100 parts gets a re-up for the next batch automatically rather than
having to re-init.

#### `POST /api/public/upload-tickets/:ticketId/upload/multipart/complete`

Request body:

```json
{
  "parts": [
    { "partNumber": 1, "etag": "\"abcd...\"" },
    { "partNumber": 2, "etag": "\"efgh...\"" }
  ]
}
```

Response (200):

```json
{ "status": "completed", "fileId": "..." }
```

Errors:

- `404 not_found` — ticket id unknown.
- `409 invalid_state` — ticket already completed (return `status:
  "completed", fileId: "..."` 200 idempotency instead), failed, or
  expired.
- `400 invalid_parts` — count mismatch, gap, S3 `InvalidPart` /
  `InvalidPartOrder` / `EntityTooSmall`.
- `403 policy_rejected` — re-validated link policy says no (mirrors the
  single-PUT finalize re-validation in `tickets/upload-tickets.ts:288-316`).

#### `POST /api/public/upload-tickets/:ticketId/upload/multipart/abort`

Request body: empty (or `{}`).

Response (200): `{ "status": "aborted" }`.

Idempotent: an abort on an already-aborted, completed, or unknown ticket
returns 200 with the same shape. (Completed: no-op, does NOT delete the
final object.) The route layer relies on the provider's idempotent abort
plus the ticket-module's state machine (DB-team agent).

#### `GET /api/public/upload-tickets/:ticketId/upload/multipart/parts?from=N&to=M`

Returns the next batch of presigned part URLs. Constraints: `1 <= from <=
to <= partCount`, `to - from + 1 <= 100`. Response:

```json
{
  "parts": [{ "partNumber": 101, "url": "...", "expiresAt": "..." }],
  "partsRemaining": 0,
  "nextPartsUrl": null
}
```

Errors:

- `404 not_found` — ticket id unknown.
- `400 invalid_range` — bounds violation.
- `409 invalid_state` — ticket not in `pending`.

### 4.2 Admin send-link multipart endpoints

Mounted under `/api/send-links/:linkId/...`, authed by `requireAdmin`.
Symmetric to the public surface, with the same JSON shapes:

- `POST /api/send-links/:linkId/files/multipart/init` — body identical to
  the existing `POST /:id/files` body (`{ filename, contentType, size }`,
  no password). Response same shape as receive-link init.
- `POST /api/send-links/:linkId/files/multipart/:ticketId/complete`
- `POST /api/send-links/:linkId/files/multipart/:ticketId/abort`
- `GET  /api/send-links/:linkId/files/multipart/:ticketId/parts?from=&to=`

The ticket-id-bearing endpoints could equivalently live under
`/api/public/upload-tickets/:ticketId/...` (since the ticket id is the
authorisation) — and §4.1 already exposes them there. The admin variants
are redundant route aliases for UI symmetry; recommend collapsing to a
single `/api/public/upload-tickets/:ticketId/...` surface for
complete/abort/parts (the ticket id is the authorisation, the same way
single-PUT finalize today is on `/api/public/upload-tickets/:ticketId/
finalize` regardless of intent). The intent-specific INIT endpoints stay
distinct because they bind to the link.

### 4.3 Local-mode part-receive route

File: `apps/server/src/routes/storage.ts`. Mounted at `/api/storage/o`
when `config.storage.backend === 'local'`. New handler:

```
PUT /api/storage/o/multipart/part/:uploadId/:partNumber?exp=&cl=&sig=
```

Validation rules in order (any failure returns 400/403 without writing):

1. `uploadId` matches `/^[a-f0-9]{32}$/` → else `400 invalid_upload_id`.
2. `partNumber` parses as integer, `1 <= n <= 10_000` → else `400 invalid_part_number`.
3. `checkSignature` succeeds with `method='PUT-PART'`. The verifier must
   recover `key` from `<.multipart>/<uploadId>/meta.json` BEFORE
   verifying because the canonical includes `key` — open `meta.json`, get
   `meta.key`, then run `verifySignature` with that key. If `meta.json`
   is missing → `403 invalid_signature` (do not leak that the session is
   gone via a distinct 404; the unsigned probe should look the same as
   any other bad sig).
4. Signed `cl` (Content-Length) is present (required for multipart parts).
5. Header `Content-Length` matches signed `cl` (same code path as
   `routes/storage.ts:52-58`, the existing single-PUT header-parity check).
6. `partNumber <= meta.expectedParts`.

On success, stream the body using the exact same handle-write loop as the
single-PUT route (`routes/storage.ts:73-129`), targeting
`<.multipart>/<uploadId>/<partNumber>.part.tmp-<rand>` and renaming to
`<partNumber>.part` after fsync. Per-part etag is the streamed hex sha256.

Response (200):

```json
{ "etag": "<hex sha256>", "size": 16777216 }
```

Same overrun / mismatch / `write_failed` error shapes as the single-PUT
route — the disk-fill DoS guard is preserved because every part PUT
signs a precise `Content-Length` derived from session state, never client
input.

Also: write a sidecar `<partNumber>.part.meta.json` with `{ etag, size }`
for the rare path where the same part is re-uploaded after a network
failure — the re-upload simply overwrites the tmp file, renames over the
existing `.part` file, and the sidecar reflects the latest etag.
`completeMultipart` always recomputes etag during concatenation, so the
sidecar is informational, not authoritative.

### 4.4 Pagination boundary justification

| File size | partSize | partCount | Init payload (URLs inline at 100 cap) |
| --------- | -------- | --------- | -------------------------------------- |
| 100 MB    | 16 MiB   | 7         | All 7 inline                           |
| 2 GiB     | 16 MiB   | 128       | First 100 + nextPartsUrl for 101–128   |
| 50 GiB    | 16 MiB   | 3200      | First 100 + nextPartsUrl, 32 batches   |
| 5 TiB     | 524 MiB  | 10_000    | First 100 + nextPartsUrl, 100 batches  |

The 100-per-batch cap keeps every HTTP response under ~150 KB. The
batch-on-demand pattern lets the part-URL TTL be re-issued for later
batches if the upload is slow — for a 50 GiB upload on a 100 Mbps link
(~70 min), the default 300s presign TTL would expire during a single
batch otherwise, breaking the upload silently. Batching dodges that
without making clients carry presign-refresh logic explicitly.

---

## 5. Security / threat model

### 5.1 Part URL cannot become a `PutObject` for the final key

**S3 mode**: SigV4 presigns are bound to `UploadPart` (which requires
`uploadId` + `partNumber` query params) or `PutObject` (which does not).
A presign minted with `UploadPartCommand` rejects when replayed against
`PutObject` because SigV4 covers the full URL — different paths, different
required headers/params, different signatures. No cross-method confusion.

**Local mode**: the canonical's `method` line is `PUT-PART` for part PUTs
and `PUT` for single PUTs. The PUT-PART verifier in
`routes/storage.ts` is wired with `method='PUT-PART'` and the single-PUT
verifier with `method='PUT'`; even if an attacker reshuffled query params
between endpoints, the canonical line 1 mismatches and `verifySignature`
returns false. Additionally, the path layouts differ
(`/api/storage/o/multipart/part/<uploadId>/<partNumber>` vs
`/api/storage/o/put/<key>`), so an attacker cannot point a PUT-PART URL
at the single-PUT handler.

### 5.2 Disk-fill DoS at the part route

The local part-PUT route signs and enforces `Content-Length`:

- The provider's `presignUploadPart` computes the exact byte count for
  this part from `meta.json` (server-held state).
- The route compares the header `Content-Length` to the signed `cl` and
  rejects on mismatch (403 before any bytes are read).
- The streaming loop counts bytes and short-circuits on overrun
  (`bytesReceived > signedCl`), exactly mirroring the single-PUT guard at
  `routes/storage.ts:99-102`.

This extends the existing disk-fill protection to multipart with no
new attack surface.

### 5.3 What binds the uploader to the uploadId?

**Recommendation: the URL signature, not the ticket id.** The server
mints the uploadId; an attacker does not learn it. Each presigned part
URL embeds the (key, uploadId, partNumber, exp, cl) canonical signed by
the server secret. An attacker who guesses an uploadId still cannot mint
a valid part-PUT signature without the HMAC secret (local) or the IAM
credentials (S3).

The ticket-id is also kept secret (it's in the init response only to the
original uploader), but it does not directly authorise the part PUTs —
the signed URLs do. This means even a leaked ticket id cannot redirect
parts elsewhere; the parts route only accepts the exact signed URLs the
ticket-bearer received.

For the `complete` / `abort` endpoints, the ticket id IS the authorisation
(same as the existing single-PUT `finalize` endpoint). This is consistent
with the rest of the surface.

### 5.4 Cross-tenant isolation

A receive-link upload's parts land in `.multipart/<uploadId>/`, never
under another link's key prefix. The eventual rename target
(`receive/<linkId>/<ticketId>/<filename>`) is set at init time, frozen
into `meta.json`, and the part PUT's signature is bound to that key. A
malicious client cannot relocate a partial upload to a different
link/ticket because they cannot mint a new signature.

---

## 6. Part-size + concurrency policy

### 6.1 Part size resolution

```ts
function resolvePartSize(sizeHint: number, configuredMin: number): number {
  return Math.max(configuredMin, Math.ceil(sizeHint / 10_000));
}
```

- `configuredMin` is `STORAGE_MULTIPART_PART_SIZE_BYTES`, default `16 *
  1024 * 1024` (16 MiB). Config parser clamps to `>= 5 * 1024 * 1024` and
  `<= 5 * 1024 * 1024 * 1024` (S3 limits).
- The `ceil(sizeHint / 10_000)` term enforces the 10 000-part S3 ceiling,
  bumping partSize for files larger than `10_000 * partSizeMin`. For a
  16 MiB default, that triggers above 160 GiB.
- Returned in the `init` response so the client knows exactly how to
  slice. Server is the single source of truth for partSize.

### 6.2 Client concurrency

Default 4 simultaneous part PUTs. Configurable via
`VITE_MULTIPART_CONCURRENCY` (frontend env). The server has no opinion;
backpressure is on the storage backend (S3 rate-limits naturally; local
backend is bounded by the Node event loop and disk).

### 6.3 Per-part retry

Max 3 retries, exponential backoff: 1s / 2s / 4s with up to ±25% jitter.
Retried errors: network errors, HTTP 5xx, HTTP 408, HTTP 429. NOT
retried: HTTP 400/403/404 (signature problems are not transient). After
exhausting retries on any part, the upload is failed and the frontend
calls `abort`.

---

## 7. Edge cases

### 7.1 Init called twice for the same ticket id

Cannot happen as posed: `init` is what *creates* the ticket id. The
realistic case is a client that network-retries the init POST. Both calls
mint a fresh ticket id + uploadId; the first session is orphaned and the
sweep aborts it after `STORAGE_MULTIPART_TTL_SECONDS`. **Recommended:
accept this and let sweep clean up.** Per-request idempotency keys are
out of scope.

The DB-team agent may add an `Idempotency-Key` header later — the
storage-layer doc is agnostic.

### 7.2 Complete with wrong part count / out-of-order parts

- **Wrong count**: provider rejects with `part count mismatch` (local) or
  `400 InvalidPartOrder` / `400 InvalidPart` (S3). Route returns
  `400 invalid_parts`.
- **Out-of-order**: both providers sort defensively before submitting/
  concatenating, so the upload succeeds. Gaps still fail (local detects
  in the gap-check loop; S3 surfaces `InvalidPart`).

### 7.3 Complete called before all parts uploaded

- **S3**: `CompleteMultipartUploadCommand` returns `400 InvalidPart` for
  any part S3 has not received. Surfaced as `400 invalid_parts`.
- **Local**: the provider's `fs.stat` on the missing part throws `ENOENT`,
  which the route maps to `400 invalid_parts`.

### 7.4 Abort called after Complete

- Provider abort sees no session (already cleaned up at complete time):
  S3 returns 404 → swallowed; local sees ENOENT → swallowed.
- Route returns `200 { status: "aborted" }`. **The completed object is
  NOT deleted.** Abort is for in-flight sessions; deleting committed
  files goes through the file-deletion path.
- Ticket-module sees `status='completed'` and refuses the state transition
  to `aborted` (DB-team concern).

### 7.5 Sweep aborting a session mid-complete

CAS-style status transition on the ticket row (DB-team owns the table;
this is the contract the storage doc relies on):

- `complete` does `UPDATE upload_tickets SET status='completing' WHERE id=? AND status='pending'`.
  If `changes === 0`, the row is no longer pending — re-read and return
  whatever the current state is (`completed`/`failed`/`aborted`/`expired`).
- Sweep's abort phase guards `WHERE status='pending' AND ...`, so it
  cannot transition a row that `complete` has already moved to
  `completing`.
- The provider call (S3 `CompleteMultipartUpload` or local concat+rename)
  happens with the row in `completing`. On success, transition to
  `completed`; on failure, transition to `failed`.

This eliminates the race window where sweep could abort an S3 session
that `complete` is mid-flight against. The worst remaining case: sweep
aborts the S3 session a microsecond before `complete` flips the row to
`completing` — `complete` then sees S3 return `404 NoSuchUpload` and
surfaces `409 aborted` to the client.

### 7.6 S3 returning 200 with `<Error>` body on Complete

aws-sdk-js v3 surfaces most of these as thrown errors via the
deserialisation middleware. Belt-and-braces in `completeMultipart`:

```ts
const res = await client.send(new CompleteMultipartUploadCommand({...}));
if (!res.ETag) {
  throw new Error(`...200 with no ETag...`);
}
```

This catches the residual case where the SDK does not recognise an error
shape and surfaces a "successful" response with no body. Treated as a
hard failure; the ticket is flipped to `failed`.

### 7.7 Sweep of orphaned local `.multipart/<uploadId>` dirs

The provider's `abortMultipart` is called by the ticket-module sweep
(DB-team), keyed by uploadId from the ticket row. Belt-and-braces: a
boot-time or sweep-time scan of `${objectsDir}/.multipart/` that removes
any dir whose `meta.json.createdAt` is older than `STORAGE_MULTIPART_TTL_SECONDS`
catches the case where the ticket row was hard-deleted (link cascade
delete with no pre-abort hook) but the parts dir survived. Recommend
adding this as a fifth sweep phase, scoped to local-backend deployments.

### 7.8 Re-upload of a single part after network failure

The frontend retry path re-PUTs the same `<partNumber>` with a fresh
streamed body. Local route: write to `<partNumber>.part.tmp-<rand>`,
fsync, rename over the existing `<partNumber>.part`. fs.rename is atomic
on POSIX, so a concurrent `complete` either sees the old part (and
concatenates that) or the new part (and concatenates that) — never a
half-written part. S3: `UploadPart` is naturally re-upload-safe; the new
etag replaces the old.

---

## 8. Config additions (cross-reference, owned by `config.ts`)

For completeness — these envs back the policies above. The DB-team /
config-agent owns the exact parser code.

- `STORAGE_MULTIPART_THRESHOLD_BYTES` — default `100 * 1024 * 1024`. The
  frontend uses this to pick single-PUT vs multipart. Exposed via a new
  `/api/config/upload` endpoint.
- `STORAGE_MULTIPART_PART_SIZE_BYTES` — default `16 * 1024 * 1024`.
  Minimum partSize for resolvePartSize(). Clamped to `[5 MiB, 5 GiB]`.
- `STORAGE_MULTIPART_TTL_SECONDS` — default `2 * 3600` (2 h). After this,
  sweep aborts the session.

The provider closures read `config.multipartPartSizeBytes` at construction
time; no other config touches the storage layer.

---

## 9. File-by-file change summary

| File | Change |
| ---- | ------ |
| `apps/server/src/storage/index.ts` | Extend `StorageProvider` with the four new methods + new type exports. |
| `apps/server/src/storage/s3.ts` | Add session map; implement `initMultipart`/`presignUploadPart`/`completeMultipart`/`abortMultipart`; import the four new SDK commands. |
| `apps/server/src/storage/local.ts` | Add `.multipart` session dir handling; implement the same four methods; export `UPLOAD_ID_PATTERN` for the route. |
| `apps/server/src/storage/signing.ts` | Add `'PUT-PART'` to `CanonicalMethod`; add `uploadId?` and `partNumber?` to `CanonicalParams`; extend `canonical()` with two positional lines. |
| `apps/server/src/routes/storage.ts` | New `PUT /multipart/part/:uploadId/:partNumber` handler reusing the existing PUT loop, signing check, and overrun guard. |
| `apps/server/src/routes/public-receive-links.ts` | New `POST /:code/upload/multipart/init`. |
| `apps/server/src/routes/public-upload-tickets.ts` | New `POST /:ticketId/upload/multipart/complete`, `POST /:ticketId/upload/multipart/abort`, `GET /:ticketId/upload/multipart/parts`. |
| `apps/server/src/routes/send-links.ts` | New `POST /:linkId/files/multipart/init`. |
| `apps/server/src/config.ts` | Three new envs threaded into `StorageConfig`. |

No new modules. No parallel patterns. The HMAC signing module gains one
method literal and two optional fields; the storage interface gains four
methods alongside the existing five; the local storage route gains one
handler alongside the existing three. Each change extends an existing
seam.
