import { StoredSession } from './SessionStorage';

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  remainingDailyLimitUSD: number;
}

export class SpendingTracker {
  checkLimits(session: StoredSession, amountUSD: number): LimitCheckResult {
    const now = Date.now();
    let { dailySpentUSD, dailyResetAt } = session.metadata;

    // Reset daily limit if 24h passed
    if (now > dailyResetAt) {
      dailySpentUSD = 0;
      dailyResetAt = now + 24 * 60 * 60 * 1000;
    }

    // Check per-transaction limit
    if (amountUSD > session.config.perTransactionLimitUSD) {
      return {
        allowed: false,
        reason: `Transaction amount $${amountUSD} exceeds per-transaction limit $${session.config.perTransactionLimitUSD}`,
        remainingDailyLimitUSD: session.config.dailyLimitUSD - dailySpentUSD
      };
    }

    // Check daily limit
    if (dailySpentUSD + amountUSD > session.config.dailyLimitUSD) {
      return {
        allowed: false,
        reason: `Transaction amount $${amountUSD} exceeds remaining daily limit $${session.config.dailyLimitUSD - dailySpentUSD}`,
        remainingDailyLimitUSD: session.config.dailyLimitUSD - dailySpentUSD
      };
    }

    return {
      allowed: true,
      remainingDailyLimitUSD: session.config.dailyLimitUSD - (dailySpentUSD + amountUSD)
    };
  }

  recordSpending(session: StoredSession, amountUSD: number): void {
    const now = Date.now();
    
    // Reset daily limit if 24h passed
    if (now > session.metadata.dailyResetAt) {
      session.metadata.dailySpentUSD = 0;
      session.metadata.dailyResetAt = now + 24 * 60 * 60 * 1000;
    }

    session.metadata.dailySpentUSD += amountUSD;
    session.metadata.totalSpentUSD += amountUSD;
    session.metadata.lastUsedAt = now;
    session.metadata.transactionCount += 1;
  }
}
