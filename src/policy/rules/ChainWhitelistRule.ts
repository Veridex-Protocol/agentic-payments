/**
 * @module ChainWhitelistRule
 * Blocks actions targeting chains not in the mandate's allowedChains list.
 * Empty allowedChains = all chains are permitted.
 */

import type { PolicyRule, PolicyCheck, EvaluationContext, RuleSeverity } from '../types';

export class ChainWhitelistRule implements PolicyRule {
  readonly id = 'chain-whitelist';
  readonly name = 'Chain Whitelist';
  readonly severity: RuleSeverity = 'critical';
  enabled = true;

  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { action, mandate } = ctx;

    if (mandate.allowedChains.length === 0) {
      return this.pass('No chain restrictions configured');
    }

    const allowed = mandate.allowedChains.includes(action.chain);

    if (!allowed) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: false,
        verdict: 'block',
        reason: `Chain ${action.chain} is not in the allowed list: [${mandate.allowedChains.join(', ')}]`,
        riskContribution: 40,
        metadata: { chain: action.chain, allowedChains: mandate.allowedChains },
      };
    }

    return this.pass(`Chain ${action.chain} is whitelisted`);
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
