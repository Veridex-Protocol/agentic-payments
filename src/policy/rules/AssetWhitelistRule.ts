/**
 * @module AssetWhitelistRule
 * Blocks actions involving tokens/assets not in the mandate's allowedAssets list.
 * Empty allowedAssets = all assets are permitted.
 */

import type { PolicyRule, PolicyCheck, EvaluationContext, RuleSeverity } from '../types';

export class AssetWhitelistRule implements PolicyRule {
  readonly id = 'asset-whitelist';
  readonly name = 'Asset Whitelist';
  readonly severity: RuleSeverity = 'critical';
  enabled = true;

  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { action, mandate } = ctx;

    // If empty whitelist, pass (all allowed)
    if (mandate.allowedAssets.length === 0) {
      return this.pass('No asset restrictions configured');
    }

    const allowed = mandate.allowedAssets.some(
      (a) => a.toLowerCase() === action.asset.toLowerCase()
    );

    if (!allowed) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: false,
        verdict: 'block',
        reason: `Asset "${action.asset}" is not in the allowed list: [${mandate.allowedAssets.join(', ')}]`,
        riskContribution: 40,
        metadata: { asset: action.asset, allowedAssets: mandate.allowedAssets },
      };
    }

    return this.pass(`Asset "${action.asset}" is whitelisted`);
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
