// Ad-hoc verification harness for the ticket-sweep job (issue #10). Not part
// of the shipped product — run manually against a MinIO-backed dev DB to
// confirm the sweep's behaviour. Not committed to package.json scripts.
//
// Usage (loads .env from repo root via --env-file):
//   node --env-file=./.env --experimental-strip-types scripts/verify-sweep.mjs
//
// Touches a temporary SQLite file under /tmp so the dev DB is left untouched.

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../apps/server/src/db/client.ts';
import {
  downloadTickets,
  sendLinks,
  uploadTickets,
  receiveLinks,
} from '../apps/server/src/db/schema.ts';
import { createDownloadTicketsModule } from '../apps/server/src/tickets/download-tickets.ts';
import { createSendLinksModule } from '../apps/server/src/links/send-links.ts';
import { createFilesModule } from '../apps/server/src/files/files.ts';
import { createTicketSweeper } from '../apps/server/src/tickets/sweep.ts';
import { eq } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = `/tmp/fileharbor-sweep-verify-${Date.now()}.db`;
const migrationsFolder = resolve(here, '../apps/server/drizzle');
mkdirSync(dirname(dbPath), { recursive: true });

const db = openDatabase(dbPath, migrationsFolder);

const sendLinksModule = createSendLinksModule(db);
const filesModule = createFilesModule(db);
// Stub storage — we don't actually hit S3 in this script. presignGet returns
// a fake URL because we never let the recipient flow reach that branch when
// pre-inserting tickets directly.
const fakeStorage = {
  async presignPut() { return { url: 'http://stub/put', expiresAt: new Date() }; },
  async presignGet() { return { url: 'http://stub/get', expiresAt: new Date(Date.now() + 60_000) }; },
  async presignDelete() { return { url: 'http://stub/del', expiresAt: new Date() }; },
  async headObject() { return null; },
  async deleteObject() {},
};
const downloadTicketsModule = createDownloadTicketsModule(
  db,
  fakeStorage,
  sendLinksModule,
  filesModule,
);

const presignTtlSeconds = 60;
const pendingGraceSeconds = 5;
const retentionSeconds = 10;

const sweeper = createTicketSweeper({
  db,
  downloadTicketsModule,
  presignTtlSeconds,
  intervalSeconds: 9999, // we drive runOnce manually
  pendingGraceSeconds,
  retentionSeconds,
});

const now = Math.floor(Date.now() / 1000);

// -----------------------------------------------------------------------------
// Setup: a receive link, a send link with a file, and tickets in various states.
// -----------------------------------------------------------------------------

const receiveLink = await (async () => {
  const id = randomUUID();
  db.insert(receiveLinks)
    .values({
      id,
      code: 'rcv1',
      label: 'verify-rl',
      passwordHash: null,
      maxUploads: null,
      expiresAt: null,
      status: 'active',
      createdAt: now - 1000,
    })
    .run();
  return { id };
})();

const sendLink = await sendLinksModule.create({
  label: 'verify-sl',
  maxDownloads: 2,
});

// Attach one file to the send link so download-ticket policy passes.
const fileId = randomUUID();
await filesModule.create({
  id: fileId,
  s3Key: `send/${sendLink.id}/${fileId}/x.txt`,
  filename: 'x.txt',
  contentType: 'text/plain',
  size: 5,
  receiveLinkId: null,
  sendLinkId: sendLink.id,
});

// ---- Upload tickets:
// A. pending, old enough to expire (created > TTL+grace ago).
const upTicketStale = randomUUID();
db.insert(uploadTickets)
  .values({
    id: upTicketStale,
    intent: 'receive',
    receiveLinkId: receiveLink.id,
    sendLinkId: null,
    s3Key: 'receive/x/y/stale',
    filename: 'stale',
    contentType: 'application/octet-stream',
    sizeHint: 1,
    status: 'pending',
    createdAt: now - presignTtlSeconds - pendingGraceSeconds - 10,
    completedAt: null,
  })
  .run();

// B. pending, fresh (must NOT be expired).
const upTicketFresh = randomUUID();
db.insert(uploadTickets)
  .values({
    id: upTicketFresh,
    intent: 'receive',
    receiveLinkId: receiveLink.id,
    sendLinkId: null,
    s3Key: 'receive/x/y/fresh',
    filename: 'fresh',
    contentType: 'application/octet-stream',
    sizeHint: 1,
    status: 'pending',
    createdAt: now,
    completedAt: null,
  })
  .run();

// C. completed long ago, must be DELETED.
const upTicketAged = randomUUID();
db.insert(uploadTickets)
  .values({
    id: upTicketAged,
    intent: 'send',
    receiveLinkId: null,
    sendLinkId: sendLink.id,
    s3Key: 'send/x/y/aged',
    filename: 'aged',
    contentType: 'application/octet-stream',
    sizeHint: 1,
    status: 'completed',
    createdAt: now - retentionSeconds - 100,
    completedAt: now - retentionSeconds - 50,
  })
  .run();

// D. failed recently, must NOT be deleted.
const upTicketRecentFailed = randomUUID();
db.insert(uploadTickets)
  .values({
    id: upTicketRecentFailed,
    intent: 'receive',
    receiveLinkId: receiveLink.id,
    sendLinkId: null,
    s3Key: 'receive/x/y/recentfailed',
    filename: 'rf',
    contentType: 'application/octet-stream',
    sizeHint: 1,
    status: 'failed',
    createdAt: now - 5,
    completedAt: now - 5,
  })
  .run();

// ---- Download tickets:
// E. pending, expires_at in the past — must be expired AND burn quota.
const dlTicketStale = randomUUID();
db.insert(downloadTickets)
  .values({
    id: dlTicketStale,
    sendLinkId: sendLink.id,
    fileId,
    s3Key: `send/${sendLink.id}/${fileId}/x.txt`,
    filename: 'x.txt',
    presignedGetUrl: 'http://stub/get',
    expiresAt: now - pendingGraceSeconds - 30,
    status: 'pending',
    createdAt: now - 100,
    completedAt: null,
  })
  .run();

// F. pending, expires_at in the future — must NOT be expired.
const dlTicketFresh = randomUUID();
db.insert(downloadTickets)
  .values({
    id: dlTicketFresh,
    sendLinkId: sendLink.id,
    fileId,
    s3Key: `send/${sendLink.id}/${fileId}/x.txt`,
    filename: 'x.txt',
    presignedGetUrl: 'http://stub/get',
    expiresAt: now + 1000,
    status: 'pending',
    createdAt: now,
    completedAt: null,
  })
  .run();

// G. completed long ago — must be deleted.
const dlTicketAged = randomUUID();
db.insert(downloadTickets)
  .values({
    id: dlTicketAged,
    sendLinkId: sendLink.id,
    fileId,
    s3Key: `send/${sendLink.id}/${fileId}/x.txt`,
    filename: 'x.txt',
    presignedGetUrl: 'http://stub/get',
    expiresAt: now - 5000,
    status: 'completed',
    createdAt: now - retentionSeconds - 200,
    completedAt: now - retentionSeconds - 100,
  })
  .run();

console.log('--- before sweep ---');
console.log(
  'send link download_count:',
  db.select({ c: sendLinks.downloadCount }).from(sendLinks).where(eq(sendLinks.id, sendLink.id)).get(),
);

// -----------------------------------------------------------------------------
// Sweep!
// -----------------------------------------------------------------------------
const counters = await sweeper.runOnce(now);
console.log('--- runOnce returned ---', counters);

// -----------------------------------------------------------------------------
// Assertions.
// -----------------------------------------------------------------------------
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

const upStale = db.select().from(uploadTickets).where(eq(uploadTickets.id, upTicketStale)).get();
assert(upStale?.status === 'expired', 'stale pending upload_ticket is expired');

const upFresh = db.select().from(uploadTickets).where(eq(uploadTickets.id, upTicketFresh)).get();
assert(upFresh?.status === 'pending', 'fresh pending upload_ticket is preserved');

const upAged = db.select().from(uploadTickets).where(eq(uploadTickets.id, upTicketAged)).get();
assert(upAged === undefined, 'aged completed upload_ticket is deleted');

const upRecentFailed = db.select().from(uploadTickets).where(eq(uploadTickets.id, upTicketRecentFailed)).get();
assert(upRecentFailed !== undefined, 'recently-failed upload_ticket is retained');

const dlStale = db.select().from(downloadTickets).where(eq(downloadTickets.id, dlTicketStale)).get();
assert(dlStale?.status === 'expired', 'stale pending download_ticket is expired');

const dlFresh = db.select().from(downloadTickets).where(eq(downloadTickets.id, dlTicketFresh)).get();
assert(dlFresh?.status === 'pending', 'fresh pending download_ticket is preserved');

const dlAged = db.select().from(downloadTickets).where(eq(downloadTickets.id, dlTicketAged)).get();
assert(dlAged === undefined, 'aged completed download_ticket is deleted');

// Quota burn: download_count should be exactly 1 (E expired and burned quota).
const sl = db.select().from(sendLinks).where(eq(sendLinks.id, sendLink.id)).get();
assert(sl.downloadCount === 1, `send_link.download_count == 1 (got ${sl.downloadCount})`);

// Counters returned by runOnce should match what we observed.
assert(counters.expiredUploadTickets === 1, `counters.expiredUploadTickets == 1 (got ${counters.expiredUploadTickets})`);
assert(counters.expiredDownloadTickets === 1, `counters.expiredDownloadTickets == 1 (got ${counters.expiredDownloadTickets})`);
assert(counters.deletedUploadTickets === 1, `counters.deletedUploadTickets == 1 (got ${counters.deletedUploadTickets})`);
assert(counters.deletedDownloadTickets === 1, `counters.deletedDownloadTickets == 1 (got ${counters.deletedDownloadTickets})`);

// -----------------------------------------------------------------------------
// Quota semantics follow-up: per #11, expiring one ticket burns a slot; the
// link with maxDownloads=2 should still allow ONE more ticket to mint+confirm,
// after which a third ticket rejects with quota_exhausted.
// -----------------------------------------------------------------------------
const second = await downloadTicketsModule.createForSendLink({ linkCode: sendLink.code, fileId });
assert(second.kind === 'ok', `2nd download ticket mints ok (got ${second.kind})`);
if (second.kind === 'ok') {
  const confirmed = await downloadTicketsModule.confirm(second.value.ticketId);
  assert(confirmed.kind === 'completed', `2nd download ticket confirms (got ${confirmed.kind})`);
}
const third = await downloadTicketsModule.createForSendLink({ linkCode: sendLink.code, fileId });
assert(
  third.kind === 'policy_rejected' && third.policy.kind === 'quota_exhausted',
  `3rd download ticket rejected quota_exhausted (got ${JSON.stringify(third)})`,
);

// -----------------------------------------------------------------------------
// Race-safety: ensure a 'pending' upload ticket that "completes" during a
// sweep is NOT clobbered. Insert one that would be eligible for expiry, then
// flip it to completed via direct UPDATE, then sweep again, then verify it
// remains completed.
// -----------------------------------------------------------------------------
const raceTicket = randomUUID();
db.insert(uploadTickets)
  .values({
    id: raceTicket,
    intent: 'receive',
    receiveLinkId: receiveLink.id,
    sendLinkId: null,
    s3Key: 'receive/x/y/race',
    filename: 'race',
    contentType: 'application/octet-stream',
    sizeHint: 1,
    status: 'pending',
    createdAt: now - presignTtlSeconds - pendingGraceSeconds - 10,
    completedAt: null,
  })
  .run();

// Simulate a concurrent finalize winning the race:
db.update(uploadTickets)
  .set({ status: 'completed', completedAt: now })
  .where(eq(uploadTickets.id, raceTicket))
  .run();

await sweeper.runOnce(now);

const raceRow = db.select().from(uploadTickets).where(eq(uploadTickets.id, raceTicket)).get();
assert(raceRow?.status === 'completed', `race-winning completed upload_ticket preserved (got ${raceRow?.status})`);

// -----------------------------------------------------------------------------
// Cleanup.
// -----------------------------------------------------------------------------
if (existsSync(dbPath)) rmSync(dbPath, { force: true });
if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`, { force: true });
if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`, { force: true });

console.log('---');
console.log(process.exitCode === 1 ? 'FAILURES PRESENT' : 'all assertions passed');
