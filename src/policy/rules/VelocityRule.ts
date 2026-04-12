/**
 * @module VelocityRule
 * Detects burst patterns — too many transactions in a short window.
 * Helps prevent micro-transaction draining attacks where individually
 * small payments evade per-transaction limits.
 */

import type {
  PolicyRule,
  PolicyCheck,
  EvaluationContext,
  RuleSeverity,
} from '../types';

export interface VelocityConfig {
  /** Maximum transactions in the short window */
  maxTransactionsPerWindow: number;
  /** Short window size in ms (default: 5 minutes) */
  windowMs: number;
  /** Maximum distinct recipients in the window */
  maxDistinctRecipients?: number;
}

const DEFAULT_VELOCITY: VelocityConfig = {
  maxTransactionsPerWindow: 10,
  windowMs: 5 * 60 * 1000, // 5 minutes
  maxDistinctRecipients: 5,
};

export class VelocityRule implements PolicyRule {
  readonly id = 'velocity';
  readonly name = 'Velocity / Burst Detection';
  readonly severity: RuleSeverity = 'high';
  enabled = true;

  private config: VelocityConfig;

  constructor(config?: Partial<VelocityConfig>) {
    this.config = { ...DEFAULT_VELOCITY, ...config };
  }

  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { history = [], timestamp } = ctx;
    const cutoff = timestamp - this.config.windowMs;
    const recentTxns = history.filter((h) => h.timestamp >= cutoff);

    // Transaction count check
    if (recentTxns.length >= this.config.maxTransactionsPerWindow) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: false,
        verdict: 'escalate',
        reason: `${recentTxns.length} transactions in last ${this.formatMs(this.config.windowMs)} (limit: ${this.config.maxTransactionsPerWindow})`,
        riskContribution: 25,
        metadata: {
          count: recentTxns.length,
          limit: this.config.maxTransactionsPerWindow,
          windowMs: this.config.windowMs,
        },
      };
    }

    // Distinct recipients check
    if (this.config.maxDistinctRecipients !== undefined) {
      const recipients = new Set(recentTxns.map((h) => h.recipient.toLowerCase()));
      if (recipients.size >= this.config.maxDistinctRecipients) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'flag',
          reason: `${recipients.size} distinct recipients in last ${this.formatMs(this.config.windowMs)} (limit: ${this.config.maxDistinctRecipients})`,
          riskContribution: 15,
          metadata: {
            distinctRecipients: recipients.size,
            limit: this.config.maxDistinctRecipients,
            windowMs: this.config.windowMs,
          },
        };
      }
    }

    return {
      ruleId: this.id,
      ruleName: this.name,
      passed: true,
      verdict: 'pass',
      reason: `${recentTxns.length} transactions in window (limit: ${this.config.maxTransactionsPerWindow})`,
      riskContribution: 0,
    };
  }

  private formatMs(ms: number): string {
    if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
    if (ms >= 60000) return `${Math.round(ms / 60000)}min`;
    return `${Math.round(ms / 1000)}s`;
  }
}
