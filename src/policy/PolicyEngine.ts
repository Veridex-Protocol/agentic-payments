/**
 * @packageDocumentation
 * @module PolicyEngine
 * @description
 * Evaluates proposed agent actions against the active mandate.
 *
 * Rules are executed in severity order (critical → low). The engine short-circuits
 * on `block` verdicts from critical rules. Non-critical rules contribute to the
 * aggregate risk score but don't short-circuit.
 *
 * The engine is stateless per evaluation — all state (spending history, session data)
 * is passed in via the `EvaluationContext`.
 */

import type {
  Mandate,
  PolicyRule,
  PolicyCheck,
  VerdictResult,
  EvaluationContext,
  Verdict,
  RuleSeverity,
} from './types';

const SEVERITY_ORDER: Record<RuleSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export class PolicyEngine {
  private rules: Map<string, PolicyRule> = new Map();
  private mandate: Mandate;

  constructor(mandate: Mandate) {
    this.mandate = mandate;

    // Load mandate's custom rules if any
    if (mandate.customRules) {
      for (const rule of mandate.customRules) {
        this.addRule(rule);
      }
    }
  }

  /** Register a policy rule. Replaces existing rule with same ID. */
  addRule(rule: PolicyRule): void {
    this.rules.set(rule.id, rule);
  }

  /** Remove a rule by ID. Returns true if the rule existed. */
  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  /** Get a rule by ID. */
  getRule(id: string): PolicyRule | undefined {
    return this.rules.get(id);
  }

  /** List all registered rules. */
  getRules(): PolicyRule[] {
    return Array.from(this.rules.values());
  }

  /** Get the active mandate. */
  getMandate(): Mandate {
    return this.mandate;
  }

  /** Update the mandate. Increments version tracking but does not auto-reload rules. */
  updateMandate(mandate: Mandate): void {
    this.mandate = mandate;
    // Re-register custom rules from new mandate
    if (mandate.customRules) {
      for (const rule of mandate.customRules) {
        this.addRule(rule);
      }
    }
  }

  /**
   * Evaluate a proposed action against all active rules.
   *
   * Rules run in severity order (critical → low). A `block` verdict from a
   * critical rule short-circuits — remaining rules are skipped.
   * The aggregate risk score is the weighted sum of individual risk contributions.
   */
  async evaluate(ctx: EvaluationContext): Promise<VerdictResult> {
    const enabledRules = Array.from(this.rules.values())
      .filter((r) => r.enabled)
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    const checks: PolicyCheck[] = [];
    const reasons: string[] = [];
    let worstVerdict: Verdict = 'pass';
    let escalationTrigger: string | undefined;

    for (const rule of enabledRules) {
      const check = await rule.evaluate(ctx);
      checks.push(check);

      if (!check.passed) {
        reasons.push(`[${rule.severity}] ${rule.name}: ${check.reason}`);
      }

      // Update worst verdict
      worstVerdict = this.worstOf(worstVerdict, check.verdict);

      if (check.verdict === 'escalate' && !escalationTrigger) {
        escalationTrigger = rule.id;
      }

      // Short-circuit on critical block
      if (check.verdict === 'block' && rule.severity === 'critical') {
        break;
      }
    }

    const riskScore = this.computeRiskScore(checks);

    return {
      verdict: worstVerdict,
      riskScore,
      reasons,
      checks,
      mandateVersion: this.mandate.version,
      evaluatedAt: ctx.timestamp,
      escalationTrigger,
    };
  }

  /** Compute aggregate risk score from individual check contributions. */
  private computeRiskScore(checks: PolicyCheck[]): number {
    if (checks.length === 0) return 0;
    const total = checks.reduce((sum, c) => sum + c.riskContribution, 0);
    return Math.min(100, Math.round(total));
  }

  /** Return the more severe of two verdicts. */
  private worstOf(a: Verdict, b: Verdict): Verdict {
    const order: Record<Verdict, number> = { pass: 0, flag: 1, escalate: 2, block: 3 };
    return order[a] >= order[b] ? a : b;
  }
}
