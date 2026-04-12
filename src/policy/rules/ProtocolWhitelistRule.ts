/**
 * @module ProtocolWhitelistRule
 * Blocks actions using protocols not in the mandate's allowedProtocols list.
 * Empty allowedProtocols = all protocols are permitted.
 */

import type { PolicyRule, PolicyCheck, EvaluationContext, RuleSeverity } from '../types';

export class ProtocolWhitelistRule implements PolicyRule {
  readonly id = 'protocol-whitelist';
  readonly name = 'Protocol Whitelist';
  readonly severity: RuleSeverity = 'critical';
  enabled = true;

  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { action, mandate } = ctx;

    if (mandate.allowedProtocols.length === 0) {
      return this.pass('No protocol restrictions configured');
    }

    const allowed = mandate.allowedProtocols.includes(action.protocol);

    if (!allowed) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: false,
        verdict: 'block',
        reason: `Protocol "${action.protocol}" is not in the allowed list: [${mandate.allowedProtocols.join(', ')}]`,
        riskContribution: 35,
        metadata: { protocol: action.protocol, allowedProtocols: mandate.allowedProtocols },
      };
    }

    return this.pass(`Protocol "${action.protocol}" is whitelisted`);
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
