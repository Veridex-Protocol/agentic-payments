/**
 * @module SpendingLimitRule
 * Enforces spending limits at multiple time horizons: per-transaction, daily,
 * weekly, monthly, and lifetime. Replaces the standalone SpendingTracker
 * with a PolicyRule-compatible implementation.
 *
 * Uses the transaction history from EvaluationContext to compute rolling
 * totals, rather than maintaining mutable internal state.
 */

import type {
  PolicyRule,
  PolicyCheck,
  EvaluationContext,
  RuleSeverity,
  LimitConfig,
  TransactionHistoryEntry,
} from '../types';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

export class SpendingLimitRule implements PolicyRule {
  readonly id = 'spending-limit';
  readonly name = 'Spending Limits';
  readonly severity: RuleSeverity = 'high';
  enabled = true;

  private limits: LimitConfig;

  constructor(limits: LimitConfig) {
    this.limits = limits;
  }

  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { action, history = [], timestamp } = ctx;
    const amountUSD = action.amountUSD;

    // Per-transaction check
    const perTxLimit = this.getPerTxLimit(action.asset);
    if (amountUSD > perTxLimit) {
      return this.block(
        `Transaction $${amountUSD.toFixed(2)} exceeds per-transaction limit $${perTxLimit.toFixed(2)}`,
        30,
        { amountUSD, limit: perTxLimit, horizon: 'perTransaction' }
      );
    }

    // Daily rolling window
    const dailySpent = this.sumInWindow(history, timestamp, ONE_DAY_MS);
    if (dailySpent + amountUSD > this.limits.daily) {
      return this.block(
        `Daily spending $${(dailySpent + amountUSD).toFixed(2)} would exceed daily limit $${this.limits.daily.toFixed(2)} (already spent $${dailySpent.toFixed(2)} today)`,
        25,
        { amountUSD, dailySpent, limit: this.limits.daily, horizon: 'daily' }
      );
    }

    // Weekly rolling window (optional)
    if (this.limits.weekly !== undefined) {
      const weeklySpent = this.sumInWindow(history, timestamp, ONE_WEEK_MS);
      if (weeklySpent + amountUSD > this.limits.weekly) {
        return this.block(
          `Weekly spending $${(weeklySpent + amountUSD).toFixed(2)} would exceed weekly limit $${this.limits.weekly.toFixed(2)}`,
          20,
          { amountUSD, weeklySpent, limit: this.limits.weekly, horizon: 'weekly' }
        );
      }
    }

    // Monthly rolling window (optional)
    if (this.limits.monthly !== undefined) {
      const monthlySpent = this.sumInWindow(history, timestamp, ONE_MONTH_MS);
      if (monthlySpent + amountUSD > this.limits.monthly) {
        return this.block(
          `Monthly spending $${(monthlySpent + amountUSD).toFixed(2)} would exceed monthly limit $${this.limits.monthly.toFixed(2)}`,
          20,
          { amountUSD, monthlySpent, limit: this.limits.monthly, horizon: 'monthly' }
        );
      }
    }

    // Lifetime (optional)
    if (this.limits.lifetime !== undefined) {
      const lifetimeSpent = history.reduce((sum, h) => sum + h.amountUSD, 0);
      if (lifetimeSpent + amountUSD > this.limits.lifetime) {
        return this.block(
          `Lifetime spending $${(lifetimeSpent + amountUSD).toFixed(2)} would exceed lifetime limit $${this.limits.lifetime.toFixed(2)}`,
          25,
          { amountUSD, lifetimeSpent, limit: this.limits.lifetime, horizon: 'lifetime' }
        );
      }
    }

    const remainingDaily = this.limits.daily - dailySpent - amountUSD;
    return {
      ruleId: this.id,
      ruleName: this.name,
      passed: true,
      verdict: 'pass',
      reason: `Within limits ($${amountUSD.toFixed(2)} txn, $${remainingDaily.toFixed(2)} remaining daily)`,
      riskContribution: 0,
      metadata: { amountUSD, dailySpent, remainingDaily },
    };
  }

  /** Get the per-transaction limit, accounting for token-specific overrides. */
  private getPerTxLimit(asset: string): number {
    const override = this.limits.tokenOverrides?.[asset.toUpperCase()];
    return override?.perTransaction ?? this.limits.perTransaction;
  }

  /** Sum USD spending within a rolling time window. */
  private sumInWindow(
    history: TransactionHistoryEntry[],
    now: number,
    windowMs: number
  ): number {
    const cutoff = now - windowMs;
    return history
      .filter((h) => h.timestamp >= cutoff && h.verdict !== 'block')
      .reduce((sum, h) => sum + h.amountUSD, 0);
  }

  private block(
    reason: string,
    riskContribution: number,
    metadata: Record<string, unknown>
  ): PolicyCheck {
    return {
      ruleId: this.id,
      ruleName: this.name,
      passed: false,
      verdict: 'block',
      reason,
      riskContribution,
      metadata,
    };
  }
}
