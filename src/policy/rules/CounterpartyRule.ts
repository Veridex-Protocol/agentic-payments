/**
 * @module CounterpartyRule
 * Blocks actions targeting counterparties (recipients) not in the mandate's
 * allowedCounterparties list. Empty list = all counterparties permitted.
 */

import type { PolicyRule, PolicyCheck, EvaluationContext, RuleSeverity } from '../types';

export class CounterpartyRule implements PolicyRule {
  readonly id = 'counterparty-whitelist';
  readonly name = 'Counterparty Whitelist';
  readonly severity: RuleSeverity = 'high';
  enabled = true;

  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { action, mandate } = ctx;

    if (mandate.allowedCounterparties.length === 0) {
      return this.pass('No counterparty restrictions configured');
    }

    const allowed = mandate.allowedCounterparties.some(
      (c) => c.toLowerCase() === action.recipient.toLowerCase()
    );

    if (!allowed) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: false,
        verdict: 'block',
        reason: `Recipient "${action.recipient}" is not in the allowed counterparties list`,
        riskContribution: 35,
        metadata: {
          recipient: action.recipient,
          allowedCount: mandate.allowedCounterparties.length,
        },
      };
    }

    return this.pass(`Recipient "${action.recipient}" is a known counterparty`);
  }

  private pass(reason: string): PolicyCheck {
    return {
      ruleId: this.id,
      ruleName: this.name,
      passed: true,
      verdict: 'pass',
      reason,
      riskContribution: 0,
    };
  }
}
