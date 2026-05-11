/**
 * @packageDocumentation
 * @module SpendingTracker
 * @description
 * Enforces spending limits for active sessions.
 * 
 * This class tracks cumulative spending (in USD) against the session's configured limits:
 * - **Daily Limit**: Maximum USD spent within a 24-hour rolling window.
 * - **Per-Transaction Limit**: Maximum USD allowed for a single atomic transaction.
 * 
 * It manages the state updates for `dailySpentUSD` and strictly returns `false` if
 * a requested transaction would breach these policies.
 */
import { StoredSession } from './SessionStorage';
import {
  assertQuoteFresh,
  DEFAULT_MAX_STALE_SECONDS,
  PriceQuote,
} from '../oracle/StalePriceError';
// Re-export for compatibility if any caller imports the constant from here.
export { DEFAULT_MAX_STALE_SECONDS } from '../oracle/StalePriceError';

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  remainingDailyLimitUSD: number;
}

/**
 * Options for the strict USD-derivation path. If the caller must charge a
 * session for `nativeAmount` units of an asset priced by `quote`, passing
 * both here lets SpendingTracker (a) revalidate the quote's freshness at the
 * exact moment of the cap check and (b) compute `amountUSD` deterministically
 * from integers instead of trusting a pre-computed float.
 */
export interface StrictCheckInput {
  /** Validated price quote for the asset being spent. */
  quote: PriceQuote;
  /** Native quantity of the asset (e.g. 1.5 for 1.5 ETH). */
  nativeAmount: number;
  /**
   * Maximum allowed publish-time age at the moment of the check. Defaults to
   * the oracle module's default (60s). Hard revert if exceeded.
   */
  maxStaleSeconds?: number;
}

export class SpendingTracker {
  /**
   * Normalize the daily reset window. Mutates session.metadata in-place
   * so that both checkLimits and recordSpending share one code path
   * (VDX-PAY-002: eliminates the double-reset race condition).
   */
  private maybeResetDaily(session: StoredSession): void {
    const now = Date.now();
    if (now > session.metadata.dailyResetAt) {
      session.metadata.dailySpentCents = 0;
      session.metadata.dailyResetAt = now + 24 * 60 * 60 * 1000;
    }
  }

  /**
   * Convert USD dollar amount to integer cents to avoid floating-point
   * arithmetic errors (VDX-PAY-005).
   */
  private toCents(usd: number): number {
    return Math.round(usd * 100);
  }

  checkLimits(session: StoredSession, amountUSD: number): LimitCheckResult {
    // VDX-PAY-002: Single reset path shared with recordSpending
    this.maybeResetDaily(session);

    const amountCents = this.toCents(amountUSD);
    const dailyLimitCents = this.toCents(session.config.dailyLimitUSD);
    const perTxLimitCents = this.toCents(session.config.perTransactionLimitUSD);
    const spentCents = session.metadata.dailySpentCents ?? this.toCents(session.metadata.dailySpentUSD ?? 0);

    // Check per-transaction limit
    if (amountCents > perTxLimitCents) {
      return {
        allowed: false,
        reason: `Transaction amount $${amountUSD} exceeds per-transaction limit $${session.config.perTransactionLimitUSD}`,
        remainingDailyLimitUSD: (dailyLimitCents - spentCents) / 100,
      };
    }

    // Check daily limit (VDX-PAY-005: integer arithmetic)
    if (spentCents + amountCents > dailyLimitCents) {
      return {
        allowed: false,
        reason: `Transaction amount $${amountUSD} exceeds remaining daily limit $${(dailyLimitCents - spentCents) / 100}`,
        remainingDailyLimitUSD: (dailyLimitCents - spentCents) / 100,
      };
    }

    return {
      allowed: true,
      remainingDailyLimitUSD: (dailyLimitCents - (spentCents + amountCents)) / 100,
    };
  }

  recordSpending(session: StoredSession, amountUSD: number): void {
    // VDX-PAY-002: Single reset path — no separate reset logic
    this.maybeResetDaily(session);

    // VDX-PAY-005: Integer arithmetic — accumulate in cents
    const amountCents = this.toCents(amountUSD);
    if (session.metadata.dailySpentCents == null) {
      // Migrate from float to cents on first use
      session.metadata.dailySpentCents = this.toCents(session.metadata.dailySpentUSD ?? 0);
    }
    session.metadata.dailySpentCents += amountCents;
    // Keep dailySpentUSD in sync for backwards compatibility
    session.metadata.dailySpentUSD = session.metadata.dailySpentCents / 100;
    session.metadata.totalSpentUSD = (session.metadata.totalSpentUSD ?? 0) + amountUSD;
    session.metadata.lastUsedAt = Date.now();
    session.metadata.transactionCount += 1;
  }

  /**
   * Strict cap check that hard-reverts on a stale or missing price quote.
   *
   * Use this instead of `checkLimits(session, amountUSD)` on any payment path
   * that could be attacker-controlled. The legacy entrypoint trusts a raw
   * `amountUSD` number that a compromised upstream (routing layer, malicious
   * merchant, oracle fallback returning $1.0 for an unknown token) can lie
   * about. This method requires a validated `PriceQuote` and revalidates its
   * freshness at check time.
   *
   * Throws `StalePriceError` if the quote has aged past `maxStaleSeconds`.
   */
  checkLimitsStrict(session: StoredSession, input: StrictCheckInput): LimitCheckResult {
    const maxStale = input.maxStaleSeconds ?? DEFAULT_MAX_STALE_SECONDS;
    // Hard revert on stale quote. Callers cannot silently substitute fallbacks.
    assertQuoteFresh(input.quote, maxStale);

    if (!Number.isFinite(input.nativeAmount) || input.nativeAmount < 0) {
      return {
        allowed: false,
        reason: `Invalid nativeAmount ${input.nativeAmount}`,
        remainingDailyLimitUSD: 0,
      };
    }
    if (!Number.isFinite(input.quote.price) || input.quote.price <= 0) {
      return {
        allowed: false,
        reason: `Invalid price ${input.quote.price} for feed ${input.quote.feedId}`,
        remainingDailyLimitUSD: 0,
      };
    }

    const amountUSD = input.nativeAmount * input.quote.price;
    return this.checkLimits(session, amountUSD);
  }
}
