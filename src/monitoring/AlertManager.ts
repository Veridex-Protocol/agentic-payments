import { SpendingAlert } from '../types/agent';
import { PaymentRecord } from './AuditLogger';

export interface AlertConfig {
    spendingThresholds: number[]; // e.g., [0.5, 0.8, 0.9, 1.0]
    highValueThresholdUSD: number; // e.g., 1000
    anomalyDetectionEnabled: boolean;
    webhookUrl?: string;
}

export interface HighValueApproval {
    transactionId: string;
    amountUSD: number;
    requestedAt: number;
    expiresAt: number;
    approved: boolean;
    approvedBy?: string;
}

const DEFAULT_CONFIG: AlertConfig = {
    spendingThresholds: [0.5, 0.8, 0.9, 1.0],
    highValueThresholdUSD: 1000,
    anomalyDetectionEnabled: true,
};

export class AlertManager {
    private config: AlertConfig;
    private triggeredAlerts: Set<string> = new Set();
    private callbacks: ((alert: SpendingAlert) => void)[] = [];
    private transactionHistory: PaymentRecord[] = [];
    private pendingApprovals: Map<string, HighValueApproval> = new Map();
    private readonly APPROVAL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

    constructor(config: Partial<AlertConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    onAlert(callback: (alert: SpendingAlert) => void) {
        this.callbacks.push(callback);
    }

    /**
     * Check spending against thresholds and trigger alerts.
     */
    checkSpending(
        sessionKeyHash: string,
        dailySpentUSD: number,
        dailyLimitUSD: number
    ) {
        const ratio = dailySpentUSD / dailyLimitUSD;

        for (const threshold of this.config.spendingThresholds) {
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

        // Reset alerts if spending was reset
        if (ratio < 0.1) {
            for (const threshold of this.config.spendingThresholds) {
                this.triggeredAlerts.delete(`${sessionKeyHash}_${threshold}`);
            }
        }
    }

    /**
     * Check if a transaction is high-value and requires approval.
     */
    isHighValueTransaction(amountUSD: number): boolean {
        return amountUSD >= this.config.highValueThresholdUSD;
    }

    /**
     * Request approval for a high-value transaction.
     */
    requestApproval(transactionId: string, amountUSD: number): HighValueApproval {
        const approval: HighValueApproval = {
            transactionId,
            amountUSD,
            requestedAt: Date.now(),
            expiresAt: Date.now() + this.APPROVAL_WINDOW_MS,
            approved: false,
        };

        this.pendingApprovals.set(transactionId, approval);

        // Notify about pending approval
        const alert: SpendingAlert = {
            type: 'CRITICAL',
            message: `High-value transaction ($${amountUSD}) requires approval within 5 minutes.`,
            sessionKeyHash: transactionId,
            dailySpentUSD: amountUSD,
            dailyLimitUSD: this.config.highValueThresholdUSD,
            timestamp: Date.now(),
        };
        this.notify(alert);

        return approval;
    }

    /**
     * Approve a pending high-value transaction.
     */
    approveTransaction(transactionId: string, approverKey: string): boolean {
        const approval = this.pendingApprovals.get(transactionId);
        if (!approval) return false;

        if (Date.now() > approval.expiresAt) {
            this.pendingApprovals.delete(transactionId);
            return false; // Expired
        }

        approval.approved = true;
        approval.approvedBy = approverKey;
        return true;
    }

    /**
     * Check if a transaction has been approved.
     */
    checkApproval(transactionId: string): { approved: boolean; expired: boolean } {
        const approval = this.pendingApprovals.get(transactionId);
        if (!approval) {
            return { approved: false, expired: false };
        }

        if (Date.now() > approval.expiresAt) {
            this.pendingApprovals.delete(transactionId);
            return { approved: false, expired: true };
        }

        return { approved: approval.approved, expired: false };
    }

    /**
     * Detect anomalies in transaction patterns.
     */
    detectAnomaly(record: PaymentRecord): boolean {
        if (!this.config.anomalyDetectionEnabled) return false;

        this.transactionHistory.push(record);

        // Keep only last 100 transactions for analysis
        if (this.transactionHistory.length > 100) {
            this.transactionHistory = this.transactionHistory.slice(-100);
        }

        // Simple anomaly detection: unusual amount or frequency
        const recentTxs = this.transactionHistory.filter(
            tx => tx.timestamp > Date.now() - 60 * 60 * 1000 // Last hour
        );

        // Check for unusual frequency (more than 10 tx/hour)
        if (recentTxs.length > 10) {
            this.notify({
                type: 'WARNING',
                message: `Unusual transaction frequency detected: ${recentTxs.length} transactions in the last hour.`,
                sessionKeyHash: record.sessionKeyHash ?? 'unknown',
                dailySpentUSD: record.amountUSD ?? 0,
                dailyLimitUSD: 0,
                timestamp: Date.now(),
            });
            return true;
        }

        // Check for unusual amount (3x average)
        if (recentTxs.length > 3) {
            const avgAmount = recentTxs.reduce((sum, tx) => sum + (tx.amountUSD ?? 0), 0) / recentTxs.length;
            const recordAmount = record.amountUSD ?? 0;
            if (recordAmount > avgAmount * 3) {
                this.notify({
                    type: 'WARNING',
                    message: `Unusual transaction amount: $${recordAmount} is 3x above average ($${avgAmount.toFixed(2)}).`,
                    sessionKeyHash: record.sessionKeyHash ?? 'unknown',
                    dailySpentUSD: recordAmount,
                    dailyLimitUSD: 0,
                    timestamp: Date.now(),
                });
                return true;
            }
        }

        return false;
    }

    /**
     * Send webhook notification for alerts.
     */
    private async sendWebhook(alert: SpendingAlert): Promise<boolean> {
        if (!this.config.webhookUrl) return false;

        try {
            const response = await fetch(this.config.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'spending_alert',
                    alert,
                    timestamp: new Date().toISOString(),
                }),
            });
            return response.ok;
        } catch (error) {
            console.error('[AlertManager] Webhook delivery failed:', error);
            return false;
        }
    }

    private notify(alert: SpendingAlert) {
        this.callbacks.forEach(cb => cb(alert));
        console.warn(`[SpendingAlert] ${alert.type}: ${alert.message} (${alert.sessionKeyHash})`);

        // Send webhook asynchronously
        if (this.config.webhookUrl) {
            this.sendWebhook(alert).catch(() => { });
        }
    }

    /**
     * Clean up expired pending approvals.
     */
    cleanupExpiredApprovals(): number {
        const now = Date.now();
        let cleaned = 0;
        for (const [id, approval] of this.pendingApprovals.entries()) {
            if (approval.expiresAt < now) {
                this.pendingApprovals.delete(id);
                cleaned++;
            }
        }
        return cleaned;
    }
}
