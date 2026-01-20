import { SpendingAlert } from '../types/agent';
import { PaymentRecord } from './AuditLogger';

export class AlertManager {
    private alertThresholds = [0.5, 0.8, 0.9, 1.0];
    private triggeredAlerts: Set<string> = new Set();
    private callbacks: ((alert: SpendingAlert) => void)[] = [];

    onAlert(callback: (alert: SpendingAlert) => void) {
        this.callbacks.push(callback);
    }

    checkSpending(
        sessionKeyHash: string,
        dailySpentUSD: number,
        dailyLimitUSD: number
    ) {
        const ratio = dailySpentUSD / dailyLimitUSD;

        for (const threshold of this.alertThresholds) {
            const alertId = `${sessionKeyHash}_${threshold}`;

            if (ratio >= threshold && !this.triggeredAlerts.has(alertId)) {
                this.triggeredAlerts.add(alertId);

                const alert: SpendingAlert = {
                    type: threshold >= 0.9 ? 'CRITICAL' : 'WARNING',
                    message: `Spending reached ${threshold * 100}% of daily limit.`,
                    sessionKeyHash,
                    dailySpentUSD,
                    dailyLimitUSD,
                    timestamp: Date.now()
                };

                this.notify(alert);
            }
        }

        // Reset alerts if spending was reset (detected by ratio decrease significantly or time)
        if (ratio < 0.1) {
            // Clear alerts for this session to allow re-triggering after reset
            for (const threshold of this.alertThresholds) {
                this.triggeredAlerts.delete(`${sessionKeyHash}_${threshold}`);
            }
        }
    }

    private notify(alert: SpendingAlert) {
        this.callbacks.forEach(cb => cb(alert));
        console.warn(`[SpendingAlert] ${alert.type}: ${alert.message} (${alert.sessionKeyHash})`);
    }
}
