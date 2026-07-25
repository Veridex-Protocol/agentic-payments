/**
 * @module CredentialAssuranceRule
 * Gates agent authority on the assurance tier of the credential that roots it.
 *
 * A synced passkey (WebAuthn BE=1) is recoverable across a user's devices, but its
 * security then rests on their iCloud / Google / Microsoft account. A device-bound
 * credential (BE=0) cannot leave the authenticator. Regulated buyers routinely
 * prohibit the former for privileged operations — this rule lets a mandate say so.
 *
 * No `mandate.assurance` configured = no gating (backward compatible).
 */

import type { PolicyRule, PolicyCheck, EvaluationContext, RuleSeverity } from '../types';

export class CredentialAssuranceRule implements PolicyRule {
  readonly id = 'credential-assurance';
  readonly name = 'Credential Assurance';
  readonly severity: RuleSeverity = 'critical';
  enabled = true;

  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { action, mandate, credential } = ctx;
    const policy = mandate.assurance;

    if (!policy) {
      return this.pass('No assurance policy configured');
    }

    // We cannot vouch for authority we can't measure.
    if (!credential || credential.level === 'unknown') {
      const verdict = policy.onUnknown ?? 'flag';
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: verdict === 'pass',
        verdict,
        reason:
          'Credential assurance is unknown — the WebAuthn backup flags were not captured, ' +
          'so this action cannot be tiered by credential strength.',
        riskContribution: verdict === 'pass' ? 0 : 25,
        metadata: { level: credential?.level ?? 'unknown', keyHash: credential?.keyHash },
      };
    }

    if (credential.level === 'device-bound') {
      return this.pass('Credential is device-bound (highest assurance)');
    }

    // credential.level === 'synced'
    const onExceed = policy.onExceed ?? 'escalate';

    if (policy.requireDeviceBoundFor?.includes(action.type)) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: false,
        verdict: onExceed,
        reason:
          `Action type "${action.type}" requires a device-bound credential, but this session ` +
          'is rooted in a synced passkey (recoverable via the platform account).',
        riskContribution: 60,
        metadata: {
          level: credential.level,
          actionType: action.type,
          requireDeviceBoundFor: policy.requireDeviceBoundFor,
          backupState: credential.backupState,
          aaguid: credential.aaguid,
        },
      };
    }

    const ceiling = policy.syncedMaxPerTransactionUSD;
    if (ceiling !== undefined && action.amountUSD > ceiling) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: false,
        verdict: onExceed,
        reason:
          `Synced-passkey authority is capped at $${ceiling} per transaction; ` +
          `this action is $${action.amountUSD}. A device-bound credential is required above the cap.`,
        riskContribution: 50,
        metadata: {
          level: credential.level,
          amountUSD: action.amountUSD,
          syncedMaxPerTransactionUSD: ceiling,
          backupState: credential.backupState,
          aaguid: credential.aaguid,
        },
      };
    }

    return this.pass(
      ceiling !== undefined
        ? `Synced credential within its $${ceiling}/tx authority cap`
        : 'Synced credential permitted for this action',
    );
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
