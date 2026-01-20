/**
 * Integration Tests for Agent SDK
 * 
 * End-to-end tests verifying complete flows work correctly.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionKeyManager } from '../src/session/SessionKeyManager';
import { SpendingTracker } from '../src/session/SpendingTracker';
import { StoredSession, SessionKeyConfig } from '../src/session/SessionStorage';
import { PaymentTokenizer } from '../src/ucp/PaymentTokenizer';
import { AlertManager } from '../src/monitoring/AlertManager';
import { AuditLogger } from '../src/monitoring/AuditLogger';

// Mock the crypto functions from @veridex/sdk
vi.mock('@veridex/sdk', async () => {
    const { ethers } = await import('ethers');
    return {
        generateSecp256k1KeyPair: vi.fn().mockImplementation(() => {
            const wallet = ethers.Wallet.createRandom();
            return {
                publicKey: wallet.signingKey.publicKey,
                privateKey: new Uint8Array(Buffer.from(wallet.privateKey.slice(2), 'hex'))
            };
        }),
        computeSessionKeyHash: vi.fn().mockImplementation((pubKey) =>
            ethers.keccak256(pubKey)
        ),
        deriveEncryptionKey: vi.fn().mockResolvedValue({} as CryptoKey),
        encrypt: vi.fn().mockImplementation((data: Uint8Array) =>
            Promise.resolve(new Uint8Array([...data, 1, 2, 3]))
        ),
        decrypt: vi.fn().mockImplementation((data: Uint8Array) =>
            Promise.resolve(data.slice(0, data.length - 3))
        ),
        VeridexSDK: class { },
        createSDK: vi.fn(),
    };
});

// Helper to create mock sessions
function createMockSession(overrides: Partial<{
    keyHash: string;
    dailyLimitUSD: number;
    perTransactionLimitUSD: number;
    expiryTimestamp: number;
    dailySpentUSD: number;
    totalSpentUSD: number;
}> = {}): StoredSession {
    const {
        keyHash = '0x' + 'a'.repeat(64),
        dailyLimitUSD = 100,
        perTransactionLimitUSD = 25,
        expiryTimestamp = Date.now() + 3600000,
        dailySpentUSD = 0,
        totalSpentUSD = 0,
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
            totalSpentUSD,
            dailySpentUSD,
            dailyResetAt: Date.now() + 86400000,
            transactionCount: 0,
        },
        masterKeyHash: '0x' + 'd'.repeat(64),
    };
}

describe('Integration Tests', () => {
    describe('17.1: Agent creates session and makes payment', () => {
        let sessionManager: SessionKeyManager;

        beforeEach(() => {
            sessionManager = new SessionKeyManager();
            if (typeof localStorage !== 'undefined') {
                localStorage.clear();
            }
        });

        it('should create session and verify limits are enforced', async () => {
            const masterKey = {
                credentialId: 'test-credential-123',
                publicKeyX: BigInt('0x' + '1'.repeat(64)),
                publicKeyY: BigInt('0x' + '2'.repeat(64)),
                keyHash: '0x' + 'a'.repeat(64),
            };

            const config: SessionKeyConfig = {
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
                expiryTimestamp: Date.now() + 60 * 60 * 1000,
                allowedChains: [30],
            };

            // Create session
            const session = await sessionManager.createSession(masterKey, config);
            expect(session).toBeDefined();
            expect(session.keyHash).toBeDefined();

            // Check initial limits
            const result1 = sessionManager.checkLimits(session, 20);
            expect(result1.allowed).toBe(true);

            // Record spending
            await sessionManager.recordSpending(session, 20);
            expect(session.metadata.dailySpentUSD).toBe(20);

            // Check limits again - $85 exceeds per-transaction limit ($25)
            const result2 = sessionManager.checkLimits(session, 85);
            expect(result2.allowed).toBe(false);
            expect(result2.reason).toContain('per-transaction limit');
        });

        it('should reject transactions exceeding per-transaction limit', async () => {
            const session = createMockSession({
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
            });

            const result = sessionManager.checkLimits(session, 30);
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('per-transaction limit');
        });
    });

    describe('17.2: Agent exceeds limit and receives error', () => {
        it('should enforce spending limits and provide clear error', async () => {
            const sessionManager = new SessionKeyManager();
            const session = createMockSession({
                dailyLimitUSD: 50,
                perTransactionLimitUSD: 50,
                dailySpentUSD: 45,
            });

            const result = sessionManager.checkLimits(session, 10);

            expect(result.allowed).toBe(false);
            expect(result.reason).toBeDefined();
            expect(result.remainingDailyLimitUSD).toBeDefined();
        });
    });

    describe('17.3: Master key revokes session', () => {
        it('should immediately invalidate session on revocation', async () => {
            const sessionManager = new SessionKeyManager();
            const masterKey = {
                credentialId: 'test-credential',
                publicKeyX: BigInt(1),
                publicKeyY: BigInt(2),
                keyHash: '0xmaster',
            };

            const config: SessionKeyConfig = {
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
                expiryTimestamp: Date.now() + 3600000,
                allowedChains: [30],
            };

            // Create session
            const session = await sessionManager.createSession(masterKey, config);
            expect(session).toBeDefined();

            // Verify session works initially
            const resultBefore = sessionManager.checkLimits(session, 10);
            expect(resultBefore.allowed).toBe(true);

            // Revoke session
            await sessionManager.revokeSession(session.keyHash);

            // Session should no longer be loadable
            const loaded = await sessionManager.loadSession(session.keyHash);
            expect(loaded).toBeNull();
        });
    });

    describe('17.4: Payment tokenization flow', () => {
        it('should tokenize session and validate tokens', async () => {
            const tokenizer = new PaymentTokenizer();
            const session = createMockSession({
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
            });

            // Tokenize
            const token = await tokenizer.tokenize(session);
            expect(token.token).toBeDefined();
            expect(token.limits.dailyLimitUSD).toBe(100);

            // Validate
            const validation = tokenizer.validate(token.token);
            expect(validation.valid).toBe(true);
            expect(validation.session?.keyHash).toBe(session.keyHash);

            // Revoke
            tokenizer.revoke(token.token);
            const afterRevoke = tokenizer.validate(token.token);
            expect(afterRevoke.valid).toBe(false);
        });

        it('should revoke all tokens when session is revoked', async () => {
            const tokenizer = new PaymentTokenizer();
            const session = createMockSession({ keyHash: '0xsession123' });

            // Create multiple tokens
            const token1 = await tokenizer.tokenize(session);
            const token2 = await tokenizer.tokenize(session);

            // Both should be valid
            expect(tokenizer.validate(token1.token).valid).toBe(true);
            expect(tokenizer.validate(token2.token).valid).toBe(true);

            // Revoke all for session
            const count = tokenizer.revokeAllForSession('0xsession123');
            expect(count).toBe(2);

            // Both should be invalid
            expect(tokenizer.validate(token1.token).valid).toBe(false);
            expect(tokenizer.validate(token2.token).valid).toBe(false);
        });
    });

    describe('17.5: Monitoring and alerts integration', () => {
        it('should log payments and trigger alerts', async () => {
            const logger = new AuditLogger();
            const alertManager = new AlertManager({
                spendingThresholds: [0.8],
                highValueThresholdUSD: 50,
            });

            const alerts: any[] = [];
            alertManager.onAlert((alert) => alerts.push(alert));

            // Log a payment
            await logger.log({
                txHash: '0x123',
                status: 'confirmed',
                chain: 30,
                token: 'USDC',
                amount: BigInt(100),
                amountUSD: 100,
                recipient: '0xrecipient',
                timestamp: Date.now(),
            }, 'session-1');

            // Trigger spending alert
            alertManager.checkSpending('session-1', 85, 100);

            // Should have warning alert
            expect(alerts.length).toBeGreaterThan(0);
            expect(alerts[0].type).toBe('WARNING');
        });

        it('should require approval for high-value transactions', () => {
            const alertManager = new AlertManager({
                highValueThresholdUSD: 100,
            });

            expect(alertManager.isHighValueTransaction(50)).toBe(false);
            expect(alertManager.isHighValueTransaction(150)).toBe(true);

            // Request approval
            const approval = alertManager.requestApproval('tx-high', 500);
            expect(approval.approved).toBe(false);

            // Approve
            const approved = alertManager.approveTransaction('tx-high', 'master-key');
            expect(approved).toBe(true);

            // Verify approval
            const status = alertManager.checkApproval('tx-high');
            expect(status.approved).toBe(true);
        });
    });

    describe('17.6: Full payment flow with spending tracking', () => {
        it('should track spending across multiple transactions', async () => {
            const sessionManager = new SessionKeyManager();
            const session = createMockSession({
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 50,
            });

            // Transaction 1: $30
            let result = sessionManager.checkLimits(session, 30);
            expect(result.allowed).toBe(true);
            await sessionManager.recordSpending(session, 30);

            // Transaction 2: $40
            result = sessionManager.checkLimits(session, 40);
            expect(result.allowed).toBe(true);
            await sessionManager.recordSpending(session, 40);

            // Transaction 3: $35 (would exceed daily)
            result = sessionManager.checkLimits(session, 35);
            expect(result.allowed).toBe(false);

            // Transaction 4: $25 (just under remaining)
            result = sessionManager.checkLimits(session, 25);
            expect(result.allowed).toBe(true);
        });
    });
});
