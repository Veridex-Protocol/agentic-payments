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

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  remainingDailyLimitUSD: number;
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
}
