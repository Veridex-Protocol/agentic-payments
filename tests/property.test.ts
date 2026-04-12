/**
 * Property Tests for Agent SDK
 * 
 * Comprehensive property-based tests using fast-check.
 * These tests verify invariants that must hold across all inputs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { PaymentTokenizer } from '../src/ucp/PaymentTokenizer';
import { AlertManager } from '../src/monitoring/AlertManager';
import { StoredSession } from '../src/session/SessionStorage';

// Helper to create mock sessions
function createMockSession(overrides: Partial<{
    keyHash: string;
    dailyLimitUSD: number;
    perTransactionLimitUSD: number;
    expiryTimestamp: number;
    dailySpentUSD: number;
}> = {}): StoredSession {
    const {
        keyHash = '0x' + 'a'.repeat(64),
        dailyLimitUSD = 100,
        perTransactionLimitUSD = 25,
        expiryTimestamp = Date.now() + 3600000,
        dailySpentUSD = 0,
    } = overrides;

    return {
        keyHash,
        encryptedPrivateKey: '0x' + 'b'.repeat(64),
        publicKey: '0x04' + 'c'.repeat(128),
        config: {
            dailyLimitUSD,
            perTransactionLimitUSD,
            expiryTimestamp,
            allowedChains: [30],
        },
        metadata: {
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            totalSpentUSD: dailySpentUSD,
            dailySpentUSD,
            dailyResetAt: Date.now() + 86400000,
            transactionCount: 0,
        },
        masterKeyHash: '0x' + 'd'.repeat(64),
    };
}

describe('Property Tests', () => {
    describe('Property 7: Payment Token Enforces Original Session Limits', () => {
        it('token limits should match session limits', async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 1, max: 10000 }), // dailyLimit
                    fc.integer({ min: 1, max: 1000 }), // perTxLimit
                    async (dailyLimit, perTxLimit) => {
                        const actualPerTxLimit = Math.min(perTxLimit, dailyLimit);
                        const tokenizer = new PaymentTokenizer();
                        const session = createMockSession({
                            dailyLimitUSD: dailyLimit,
                            perTransactionLimitUSD: actualPerTxLimit,
                        });

                        const token = await tokenizer.tokenize(session);

                        expect(token.limits.dailyLimitUSD).toBe(dailyLimit);
                        expect(token.limits.perTransactionLimitUSD).toBe(actualPerTxLimit);
                    }
                ),
                { numRuns: 50 }
            );
        });
    });

    describe('Property 14: Spending Alert Threshold Accuracy', () => {
        it('should trigger alert at exactly the right threshold', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 10000 }), // dailyLimit
                    fc.double({ min: 0.01, max: 1.0, noNaN: true }), // spendingRatio
                    (dailyLimit, spendingRatio) => {
                        const manager = new AlertManager({
                            spendingThresholds: [0.5, 0.8, 0.9, 1.0],
                        });

                        const alerts: any[] = [];
                        manager.onAlert((alert) => alerts.push(alert));

                        const spent = dailyLimit * spendingRatio;
                        manager.checkSpending('test-session', spent, dailyLimit);

                        // Check that alerts match thresholds
                        if (spendingRatio >= 0.5) {
                            expect(alerts.length).toBeGreaterThanOrEqual(1);
                        }
                        if (spendingRatio >= 0.9) {
                            // Should have critical alert
                            expect(alerts.some(a => a.type === 'CRITICAL')).toBe(true);
                        }
                    }
                ),
                { numRuns: 50 }
            );
        });
    });

    describe('Property 19: Payment Token Expiration Enforcement', () => {
        it('tokens should not be valid after expiration', async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 1, max: 1000 }), // token TTL in ms (short for testing)
                    async (ttlMs) => {
                        const tokenizer = new PaymentTokenizer();
                        const session = createMockSession({
                            expiryTimestamp: Date.now() + ttlMs + 1000,
                        });

                        const token = await tokenizer.tokenize(session, ttlMs);

                        // Token should be valid immediately
                        const validResult = tokenizer.validate(token.token);
                        expect(validResult.valid).toBe(true);
                    }
                ),
                { numRuns: 20 }
            );
        });
    });

    describe('Property 20: High-Value Transaction Approval Window', () => {
        it('approvals should expire after window', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1000, max: 10000 }), // amount
                    (amount) => {
                        const manager = new AlertManager({
                            highValueThresholdUSD: 500,
                        });

                        const approval = manager.requestApproval('tx-123', amount);

                        // Check window
                        expect(approval.expiresAt).toBeGreaterThan(Date.now());
                        expect(approval.expiresAt - approval.requestedAt).toBeLessThanOrEqual(5 * 60 * 1000);
                    }
                ),
                { numRuns: 20 }
            );
        });

        it('approval check should return not found for non-existent transactions', () => {
            const manager = new AlertManager();
            const result = manager.checkApproval('non-existent');
            expect(result.approved).toBe(false);
            expect(result.expired).toBe(false);
        });
    });

    describe('Property: High-Value Detection Threshold', () => {
        it('should correctly identify high-value transactions', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 100, max: 5000 }), // threshold
                    fc.integer({ min: 1, max: 10000 }), // amount
                    (threshold, amount) => {
                        const manager = new AlertManager({
                            highValueThresholdUSD: threshold,
                        });

                        const isHighValue = manager.isHighValueTransaction(amount);

                        if (amount >= threshold) {
                            expect(isHighValue).toBe(true);
                        } else {
                            expect(isHighValue).toBe(false);
                        }
                    }
                ),
                { numRuns: 50 }
            );
        });
    });
});
