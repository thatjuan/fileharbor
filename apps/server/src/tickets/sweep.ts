import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { downloadTickets, pendingAborts, uploadTickets } from '../db/schema.js';
import type { StorageProvider } from '../storage/index.js';
import type { DownloadTicketsModule } from './download-tickets.js';

/**
 * Periodic ticket-cleanup sweep (issue #10). Runs inside the existing Node
 * process — no external worker. Two responsibilities per pass:
 *
 *   1. **Passive expiry** of `pending` tickets whose presigned URL has aged
 *      past TTL + grace. The presigned URL is already useless by then; the
 *      sweep just brings the row's status into agreement with reality.
 *      - upload_tickets: bulk atomic `UPDATE ... WHERE status='pending'`.
 *      - download_tickets: per-row, via `downloadTicketsModule.expire(id)` so
 *        the quota-burn logic in #11 stays in one place.
 *
 *   2. **Terminal retention**: delete tickets in `expired` / `failed` /
 *      `completed` whose `completed_at` (or `created_at` if null) is older
 *      than `retentionSeconds`. Schema is set up so this is safe: upload
 *      tickets have no inbound FKs, and `files.{receive,send}_link_id` use
 *      `ON DELETE SET NULL` on the link, not the ticket — there is no FK from
 *      files to upload_tickets. Download tickets are leaf rows.
 *
 * Race safety: the bulk UPDATE for pending uploads is guarded on
 * `status='pending'`, so a concurrent `finalize` that flipped the row to
 * `completed` between the sweep's tick and the UPDATE is preserved — the
 * WHERE clause filters it out. The download-ticket path delegates to
 * `expire()`, whose own transaction is `WHERE status='pending'`.
 *
 * Overlap safety: `start()` uses a self-rescheduling `setTimeout` plus an
 * in-flight promise so a slow sweep cannot stack with the next tick. `stop()`
 * cancels the pending timer and awaits any in-flight pass.
 *
 * Time injection: `runOnce(now)` accepts epoch-seconds explicitly so an
 * operator (or a verification harness) can sweep with an arbitrary "now"
 * without monkey-patching `Date`. The scheduler always passes `Date.now()/1000`.
 */

export interface SweepCounters {
  expiredUploadTickets: number;
  expiredDownloadTickets: number;
  deletedUploadTickets: number;
  deletedDownloadTickets: number;
  /**
   * Multipart sessions transitioned from `pending` → `aborting` → `expired`
   * by Phase 1.5 (TTL expiry). Counted only when the storage-side abort
   * succeeded in the same pass.
   */
  abortedPendingMultipart: number;
  /**
   * Sessions in `aborting` for which Phase 1.6 successfully called
   * `storage.abortMultipart` and CASed the row to `expired`.
   */
  drainedAborting: number;
  /**
   * Rows in `pending_aborts` for which Phase 1.7 successfully called
   * `storage.abortMultipart` and deleted the queue row.
   */
  drainedPendingAborts: number;
}

export interface TicketSweeper {
  /**
   * Run a single sweep pass. Returns counters for what changed. Errors during
   * one of the four phases are caught and logged; the other phases still run.
   * The function itself never throws — the periodic loop relies on that to
   * keep going after transient DB errors.
   */
  runOnce(nowSeconds: number): Promise<SweepCounters>;
  /** Schedule the sweep on the configured interval. Idempotent. */
  start(): void;
  /** Cancel the scheduled timer and await any in-flight pass. */
  stop(): Promise<void>;
}

export interface TicketSweeperDeps {
  db: Db;
  downloadTicketsModule: DownloadTicketsModule;
  /** Presigned-URL TTL in seconds. Sourced from storage config. */
  presignTtlSeconds: number;
  intervalSeconds: number;
  pendingGraceSeconds: number;
  retentionSeconds: number;
  /**
   * Storage provider. Sweep calls `storage.abortMultipart` from Phase 1.5,
   * 1.6, and 1.7 to free abandoned multipart sessions.
   */
  storage: StorageProvider;
  /**
   * Maximum seconds a pending multipart session may live before sweep
   * Phase 1.5 aborts it. Longer than `presignTtlSeconds` because a real
   * multipart upload can take minutes to hours; the per-URL presign
   * is re-issued on every page fetch.
   */
  multipartTtlSeconds: number;
  /**
   * Optional clock source for the scheduler. Defaults to `Date.now`. The
   * scheduler converts to epoch-seconds before passing to `runOnce`.
   */
  now?: () => number;
  /**
   * Optional logger override. Defaults to `console`. Kept narrow so the
   * surface is easy to fake in scripts.
   */
  logger?: { info(...args: unknown[]): void; error(...args: unknown[]): void };
}

const TERMINAL_STATUSES = ['expired', 'failed', 'completed'] as const;

/**
 * After this many failed `storage.abortMultipart` attempts on an `aborting`
 * row, sweep force-transitions to `expired` and emits a warn log. The S3
 * session (if any) is operator-cleanup territory after this point.
 */
const MAX_ABORT_ATTEMPTS = 20;

/**
 * After this many failed drain attempts on a `pending_aborts` row, sweep
 * stops retrying and leaves the row in the table for operator cleanup.
 * Mirrors `MAX_ABORT_ATTEMPTS`.
 */
const MAX_PENDING_ABORT_ATTEMPTS = 20;

/** Cap per-pass on the `pending_aborts` drain so a backlog can't starve other phases. */
const PENDING_ABORTS_BATCH_SIZE = 100;

export function createTicketSweeper(deps: TicketSweeperDeps): TicketSweeper {
  const {
    db,
    downloadTicketsModule,
    presignTtlSeconds,
    intervalSeconds,
    pendingGraceSeconds,
    retentionSeconds,
    storage,
    multipartTtlSeconds,
  } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.logger ?? console;

  // Scheduler state. `ReturnType<typeof setTimeout>` avoids the lint complaint
  // about the global `NodeJS` namespace while still typing precisely.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  async function runOnce(nowSeconds: number): Promise<SweepCounters> {
    const counters: SweepCounters = {
      expiredUploadTickets: 0,
      expiredDownloadTickets: 0,
      deletedUploadTickets: 0,
      deletedDownloadTickets: 0,
      abortedPendingMultipart: 0,
      drainedAborting: 0,
      drainedPendingAborts: 0,
    };

    // --- Phase 1: expire pending SINGLE-PUT upload tickets -----------------
    // Single atomic bulk UPDATE. `status='pending'` in the WHERE clause is the
    // race guard against a concurrent `finalize` flipping the row to
    // completed/failed between when the sweep "decided" and when it writes.
    //
    // Filtering `protocol='single'` keeps multipart sessions out of this
    // bulk-update — they have a longer TTL (multipartTtlSeconds, default 2h
    // vs presignTtlSeconds, default 5min) and need to be aborted at the
    // storage layer before the row can be flipped to terminal. Phase 1.5
    // owns that path.
    try {
      const uploadCutoff = nowSeconds - presignTtlSeconds - pendingGraceSeconds;
      const res = db
        .update(uploadTickets)
        .set({ status: 'expired', completedAt: nowSeconds })
        .where(
          and(
            eq(uploadTickets.status, 'pending'),
            eq(uploadTickets.protocol, 'single'),
            lt(uploadTickets.createdAt, uploadCutoff),
          ),
        )
        .run();
      counters.expiredUploadTickets = Number(res.changes);
    } catch (err) {
      log.error('[ticket-sweep] expire upload_tickets failed', err);
    }

    // --- Phase 1.5: TTL-expire pending MULTIPART upload tickets ------------
    // Two-step per row: CAS pending → aborting (race-guard against a late
    // user complete()), then call storage.abortMultipart, then CAS
    // aborting → expired. A storage failure leaves the row in `aborting`
    // for Phase 1.6 to retry.
    try {
      const multipartCutoff = nowSeconds - multipartTtlSeconds;
      const expirable = db
        .select({
          id: uploadTickets.id,
          s3Key: uploadTickets.s3Key,
          uploadId: uploadTickets.uploadId,
        })
        .from(uploadTickets)
        .where(
          and(
            eq(uploadTickets.status, 'pending'),
            eq(uploadTickets.protocol, 'multipart'),
            isNotNull(uploadTickets.uploadId),
            lt(uploadTickets.createdAt, multipartCutoff),
          ),
        )
        .all();

      for (const row of expirable) {
        if (row.uploadId === null) continue;
        const claim = db
          .update(uploadTickets)
          .set({ status: 'aborting' })
          .where(
            and(eq(uploadTickets.id, row.id), eq(uploadTickets.status, 'pending')),
          )
          .run();
        if (Number(claim.changes) === 0) continue; // raced — leave it
        try {
          await storage.abortMultipart(row.s3Key, row.uploadId);
          const settle = db
            .update(uploadTickets)
            .set({ status: 'expired', completedAt: nowSeconds })
            .where(
              and(eq(uploadTickets.id, row.id), eq(uploadTickets.status, 'aborting')),
            )
            .run();
          if (Number(settle.changes) > 0) counters.abortedPendingMultipart += 1;
        } catch (err) {
          log.error('[ticket-sweep] multipart abort failed (will retry)', {
            ticketId: row.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.error('[ticket-sweep] multipart TTL phase failed', err);
    }

    // --- Phase 1.6: drain rows stuck in `aborting` -------------------------
    // Catches three classes:
    //   - User abort calls that flipped pending → aborting but the storage
    //     call deferred to the sweep (or failed and was deferred).
    //   - Phase 1.5 rows whose `storage.abortMultipart` threw.
    //   - Process crashes between the pending → aborting CAS and the
    //     aborting → expired CAS in Phase 1.5.
    //
    // `abort_attempts` is incremented BEFORE the storage call; after
    // MAX_ABORT_ATTEMPTS we force-transition to `expired` directly (no
    // intermediate aborting → aborting hop) so the row stops looping.
    try {
      const aborting = db
        .select({
          id: uploadTickets.id,
          s3Key: uploadTickets.s3Key,
          uploadId: uploadTickets.uploadId,
          abortAttempts: uploadTickets.abortAttempts,
        })
        .from(uploadTickets)
        .where(
          and(
            eq(uploadTickets.status, 'aborting'),
            eq(uploadTickets.protocol, 'multipart'),
            isNotNull(uploadTickets.uploadId),
          ),
        )
        .all();

      for (const row of aborting) {
        if (row.uploadId === null) continue;
        const nextAttempts = row.abortAttempts + 1;
        if (nextAttempts > MAX_ABORT_ATTEMPTS) {
          // Give up — force terminal, operator-visible via abort_attempts.
          db.update(uploadTickets)
            .set({ status: 'expired', completedAt: nowSeconds })
            .where(eq(uploadTickets.id, row.id))
            .run();
          log.error('[ticket-sweep] giving up on multipart abort after 20 attempts', {
            ticketId: row.id,
            uploadId: row.uploadId,
          });
          continue;
        }
        // Bump abort_attempts first; on failure we'll still see the bump,
        // matching the cap. This isn't a CAS guard — the source status is
        // unchanged.
        db.update(uploadTickets)
          .set({ abortAttempts: nextAttempts })
          .where(eq(uploadTickets.id, row.id))
          .run();
        try {
          await storage.abortMultipart(row.s3Key, row.uploadId);
          const settle = db
            .update(uploadTickets)
            .set({ status: 'expired', completedAt: nowSeconds })
            .where(
              and(eq(uploadTickets.id, row.id), eq(uploadTickets.status, 'aborting')),
            )
            .run();
          if (Number(settle.changes) > 0) counters.drainedAborting += 1;
        } catch (err) {
          log.error('[ticket-sweep] aborting drain failed (will retry)', {
            ticketId: row.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.error('[ticket-sweep] aborting drain phase failed', err);
    }

    // --- Phase 1.7: drain `pending_aborts` ---------------------------------
    // Rows enqueued by `receive-links.remove` / `send-links.remove` (when the
    // inline best-effort abort failed) or by `completeMultipart` (on
    // storage-side failure). Ordered (attempts ASC, enqueued_at ASC) so
    // newly-enqueued rows go first, repeatedly-failing rows last.
    try {
      // Filter past-cap rows out of the SELECT so they don't get re-logged
      // every tick. Operators can query them by hand:
      //   SELECT * FROM pending_aborts WHERE attempts >= 20;
      const queue = db
        .select()
        .from(pendingAborts)
        .where(lt(pendingAborts.attempts, MAX_PENDING_ABORT_ATTEMPTS))
        .orderBy(asc(pendingAborts.attempts), asc(pendingAborts.enqueuedAt))
        .limit(PENDING_ABORTS_BATCH_SIZE)
        .all();

      for (const row of queue) {
        // Bump attempt count first so a slow/hung storage call doesn't let
        // the same row be retried on the next tick before this one settles.
        const nextAttempts = row.attempts + 1;
        db.update(pendingAborts)
          .set({ attempts: nextAttempts, lastAttemptAt: nowSeconds })
          .where(eq(pendingAborts.id, row.id))
          .run();
        try {
          await storage.abortMultipart(row.s3Key, row.uploadId);
          db.delete(pendingAborts).where(eq(pendingAborts.id, row.id)).run();
          counters.drainedPendingAborts += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          db.update(pendingAborts)
            .set({ lastError: message })
            .where(eq(pendingAborts.id, row.id))
            .run();
          log.error('[ticket-sweep] pending_aborts drain failed', {
            id: row.id,
            err: message,
          });
        }
      }
    } catch (err) {
      log.error('[ticket-sweep] pending_aborts phase failed', err);
    }

    // --- Phase 2: expire pending download tickets --------------------------
    // Per-row because `download-tickets.expire()` also burns one quota slot
    // on the parent `send_links` row. Doing this in a single UPDATE would
    // require duplicating that counter logic, and #11 explicitly placed it
    // inside `expire()` so all callers agree. The SELECT + per-id loop is
    // bounded by what's actually pending and past TTL — typically tiny.
    try {
      const downloadCutoff = nowSeconds - pendingGraceSeconds;
      const expirable = db
        .select({ id: downloadTickets.id })
        .from(downloadTickets)
        .where(
          and(
            eq(downloadTickets.status, 'pending'),
            lt(downloadTickets.expiresAt, downloadCutoff),
          ),
        )
        .all();

      for (const row of expirable) {
        try {
          const outcome = await downloadTicketsModule.expire(row.id);
          // Only the 'expired' kind reflects a real transition this pass.
          // `already_completed` means a concurrent confirm() beat us (correct
          // and desirable — quota-burn happens exactly once).
          if (outcome.kind === 'expired') {
            counters.expiredDownloadTickets += 1;
          }
        } catch (err) {
          // Per-ticket failure shouldn't take down the whole pass.
          log.error('[ticket-sweep] expire download_ticket failed', {
            ticketId: row.id,
            err,
          });
        }
      }
    } catch (err) {
      log.error('[ticket-sweep] enumerate expirable download_tickets failed', err);
    }

    // --- Phase 3: delete terminal upload tickets ---------------------------
    // `COALESCE(completed_at, created_at)` covers the edge case where a row
    // somehow lacks a `completed_at` — fall back to created_at so old rows
    // still age out instead of becoming immortal.
    try {
      const retentionCutoff = nowSeconds - retentionSeconds;
      const res = db
        .delete(uploadTickets)
        .where(
          and(
            inArray(uploadTickets.status, [...TERMINAL_STATUSES]),
            lt(
              sql`coalesce(${uploadTickets.completedAt}, ${uploadTickets.createdAt})`,
              retentionCutoff,
            ),
          ),
        )
        .run();
      counters.deletedUploadTickets = Number(res.changes);
    } catch (err) {
      log.error('[ticket-sweep] delete terminal upload_tickets failed', err);
    }

    // --- Phase 4: delete terminal download tickets -------------------------
    try {
      const retentionCutoff = nowSeconds - retentionSeconds;
      const res = db
        .delete(downloadTickets)
        .where(
          and(
            inArray(downloadTickets.status, [...TERMINAL_STATUSES]),
            lt(
              sql`coalesce(${downloadTickets.completedAt}, ${downloadTickets.createdAt})`,
              retentionCutoff,
            ),
          ),
        )
        .run();
      counters.deletedDownloadTickets = Number(res.changes);
    } catch (err) {
      log.error('[ticket-sweep] delete terminal download_tickets failed', err);
    }

    return counters;
  }

  /**
   * Run one pass, log a summary, and store the in-flight promise so `stop()`
   * can await it. Always settles — never throws — even if `runOnce` itself
   * does. The scheduler depends on that for liveness.
   */
  function scheduleAndRun(): void {
    if (stopped) return;

    const started = Date.now();
    const promise = (async () => {
      try {
        const counters = await runOnce(Math.floor(now() / 1000));
        // Only log when something happened; a quiet system shouldn't spam logs.
        const changed =
          counters.expiredUploadTickets +
          counters.expiredDownloadTickets +
          counters.deletedUploadTickets +
          counters.deletedDownloadTickets +
          counters.abortedPendingMultipart +
          counters.drainedAborting +
          counters.drainedPendingAborts;
        if (changed > 0) {
          log.info('[ticket-sweep] pass complete', {
            elapsedMs: Date.now() - started,
            ...counters,
          });
        }
      } catch (err) {
        // runOnce catches its own errors, but defence in depth in case a
        // future change throws synchronously before reaching its try/catch.
        log.error('[ticket-sweep] pass threw unexpectedly', err);
      } finally {
        inFlight = null;
        // Re-arm only if not stopped during the pass.
        if (!stopped) {
          timer = setTimeout(scheduleAndRun, intervalSeconds * 1000);
          // Allow the process to exit on its own if this is the last handle.
          timer.unref?.();
        }
      }
    })();
    inFlight = promise;
  }

  return {
    runOnce,
    start() {
      if (timer !== null || inFlight !== null || stopped) return;
      timer = setTimeout(scheduleAndRun, intervalSeconds * 1000);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Wait for any in-flight pass to settle so the caller knows the DB is
      // quiescent. `inFlight` always resolves; it never rejects.
      if (inFlight !== null) {
        await inFlight;
      }
    },
  };
}
