import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { downloadTickets, uploadTickets } from '../db/schema.js';
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

export function createTicketSweeper(deps: TicketSweeperDeps): TicketSweeper {
  const {
    db,
    downloadTicketsModule,
    presignTtlSeconds,
    intervalSeconds,
    pendingGraceSeconds,
    retentionSeconds,
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
    };

    // --- Phase 1: expire pending upload tickets ----------------------------
    // Single atomic bulk UPDATE. `status='pending'` in the WHERE clause is the
    // race guard against a concurrent `finalize` flipping the row to
    // completed/failed between when the sweep "decided" and when it writes.
    try {
      const uploadCutoff = nowSeconds - presignTtlSeconds - pendingGraceSeconds;
      const res = db
        .update(uploadTickets)
        .set({ status: 'expired', completedAt: nowSeconds })
        .where(and(eq(uploadTickets.status, 'pending'), lt(uploadTickets.createdAt, uploadCutoff)))
        .run();
      counters.expiredUploadTickets = Number(res.changes);
    } catch (err) {
      log.error('[ticket-sweep] expire upload_tickets failed', err);
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
          counters.deletedDownloadTickets;
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
