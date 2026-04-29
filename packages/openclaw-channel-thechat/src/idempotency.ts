/**
 * Webhook idempotency / deduplication layer.
 *
 * TheChat (and most webhook senders) may retry delivery when the receiver
 * returns a non-2xx status or times out.  Without deduplication, those
 * retries cause the same message to be dispatched to the OpenClaw runtime
 * multiple times — which can trigger duplicate agent responses.
 *
 * This module provides a lightweight, in-memory seen-set with TTL-based
 * expiry.  It is intentionally simple:
 *
 *   - Keyed by TheChat **message id** (unique per message, stable across
 *     retries of the same webhook event).
 *   - Entries expire after `ttlMs` (default 10 minutes), long enough to
 *     cover any realistic retry window.
 *   - A passive sweep runs every `sweepIntervalMs` (default 60 s) to
 *     reclaim memory.
 *   - `dispose()` tears down the sweep timer for clean shutdown.
 *
 * The store is per-process. In a multi-instance deployment behind a load
 * balancer with sticky sessions this is sufficient; for truly stateless
 * horizontal scaling an external store (Redis, etc.) can be substituted by
 * injecting a custom `IdempotencyStore` implementation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdempotencyStore {
  /** Returns `true` if the key was already seen (duplicate). */
  check(key: string): boolean;
  /** Mark the key as seen. Returns `true` if it was a new entry. */
  mark(key: string): boolean;
  /** Number of entries currently tracked. */
  size(): number;
  /** Remove expired entries. Returns the number swept. */
  sweep(): number;
  /** Tear down any background timers. */
  dispose(): void;
}

export interface IdempotencyStoreOptions {
  /** Time-to-live for each entry in milliseconds. Default 600_000 (10 min). */
  ttlMs?: number;
  /** Interval between passive sweeps in milliseconds. Default 60_000 (60 s). */
  sweepIntervalMs?: number;
  /** Injectable clock for tests. Returns unix ms. */
  nowMs?: () => number;
  /** Maximum entries before forced sweep. Default 10_000. */
  maxEntries?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create an in-memory idempotency store.
 *
 * ```ts
 * const store = createIdempotencyStore({ ttlMs: 600_000 });
 * // In the inbound handler:
 * if (store.check(payload.message.id)) {
 *   return { kind: "skipped", reason: "duplicate" };
 * }
 * store.mark(payload.message.id);
 * ```
 */
export function createIdempotencyStore(
  opts: IdempotencyStoreOptions = {}
): IdempotencyStore {
  const {
    ttlMs = 600_000,
    sweepIntervalMs = 60_000,
    nowMs = () => Date.now(),
    maxEntries = 10_000,
  } = opts;

  /** Map from key → expiry timestamp (unix ms). */
  const seen = new Map<string, number>();

  function sweep(): number {
    const now = nowMs();
    let swept = 0;
    for (const [key, expiresAt] of seen) {
      if (now >= expiresAt) {
        seen.delete(key);
        swept += 1;
      }
    }
    return swept;
  }

  function check(key: string): boolean {
    const expiresAt = seen.get(key);
    if (expiresAt === undefined) return false;
    // Expired entries are treated as unseen.
    if (nowMs() >= expiresAt) {
      seen.delete(key);
      return false;
    }
    return true;
  }

  function mark(key: string): boolean {
    if (check(key)) return false; // already present
    // Force sweep if we're at capacity.
    if (seen.size >= maxEntries) {
      sweep();
    }
    seen.set(key, nowMs() + ttlMs);
    return true;
  }

  // Passive background sweep.
  const timer = setInterval(sweep, sweepIntervalMs);
  // Allow Node to exit even if the timer is active.
  if (typeof timer === "object" && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  function dispose(): void {
    clearInterval(timer);
    seen.clear();
  }

  return { check, mark, size: () => seen.size, sweep, dispose };
}
