/**
 * @module TimeWindowRule
 * Blocks actions outside the mandate's configured time windows.
 * Empty timeWindows array = actions allowed at any time.
 */

import type { PolicyRule, PolicyCheck, EvaluationContext, RuleSeverity } from '../types';

export class TimeWindowRule implements PolicyRule {
  readonly id = 'time-window';
  readonly name = 'Time Window';
  readonly severity: RuleSeverity = 'medium';
  enabled = true;

  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { mandate } = ctx;

    if (mandate.timeWindows.length === 0) {
      return this.pass('No time window restrictions configured');
    }

    const now = new Date(ctx.timestamp);
    const dayOfWeek = now.getUTCDay(); // 0=Sunday
    const hourUTC = now.getUTCHours();

    // Check if current time falls within ANY allowed window
    const inWindow = mandate.timeWindows.some((w) => {
      const dayOk = w.allowedDays.length === 0 || w.allowedDays.includes(dayOfWeek);
      const afterStart = w.startHourUTC === undefined || hourUTC >= w.startHourUTC;
      const beforeEnd = w.endHourUTC === undefined || hourUTC < w.endHourUTC;
      return dayOk && afterStart && beforeEnd;
    });

    if (!inWindow) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: false,
        verdict: 'block',
        reason: `Action attempted outside allowed time windows (UTC day=${dayOfWeek}, hour=${hourUTC})`,
        riskContribution: 15,
        metadata: { dayOfWeek, hourUTC, windows: mandate.timeWindows },
      };
    }

    return this.pass(`Within allowed time window (UTC day=${dayOfWeek}, hour=${hourUTC})`);
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
