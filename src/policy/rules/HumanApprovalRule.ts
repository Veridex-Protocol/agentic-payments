/**
 * @module HumanApprovalRule
 * Escalates actions that exceed configured thresholds, requiring human
 * approval before proceeding. Uses the mandate's escalation configuration.
 */

import type { PolicyRule, PolicyCheck, EvaluationContext, RuleSeverity } from '../types';

export class HumanApprovalRule implements PolicyRule {
  readonly id = 'human-approval';
  readonly name = 'Human Approval Threshold';
  readonly severity: RuleSeverity = 'medium';
  enabled = true;

  private amountThreshold: number;
  private riskScoreThreshold: number;

  constructor(config?: { amountUSDThreshold?: number; riskScoreThreshold?: number }) {
    this.amountThreshold = config?.amountUSDThreshold ?? Infinity;
    this.riskScoreThreshold = config?.riskScoreThreshold ?? 100;
  }

  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { action } = ctx;

    // Amount-based escalation
    if (action.amountUSD >= this.amountThreshold) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: false,
        verdict: 'escalate',
        reason: `Transaction $${action.amountUSD.toFixed(2)} exceeds human approval threshold $${this.amountThreshold.toFixed(2)}`,
        riskContribution: 10,
        metadata: {
          amountUSD: action.amountUSD,
          threshold: this.amountThreshold,
          trigger: 'amount',
        },
      };
    }

    return {
      ruleId: this.id,
      ruleName: this.name,
      passed: true,
      verdict: 'pass',
      reason: `Amount $${action.amountUSD.toFixed(2)} below approval threshold`,
      riskContribution: 0,
    };
  }

  /** Update thresholds dynamically (e.g., from mandate updates). */
  updateThresholds(config: { amountUSDThreshold?: number; riskScoreThreshold?: number }): void {
    if (config.amountUSDThreshold !== undefined) this.amountThreshold = config.amountUSDThreshold;
    if (config.riskScoreThreshold !== undefined) this.riskScoreThreshold = config.riskScoreThreshold;
  }
}
