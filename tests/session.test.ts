/**
 * Session Key Manager Tests
 * 
 * Tests for session key creation, validation, and spending limit enforcement.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { SessionKeyManager } from '../src/session/SessionKeyManager';
import { StoredSession, SessionKeyConfig } from '../src/session/SessionStorage';
import { AgentPaymentError } from '../src/types/errors';

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
            Promise.resolve(new Uint8Array([...data, 1, 2, 3])) // Simple mock
        ),
        decrypt: vi.fn().mockImplementation((data: Uint8Array) =>
            Promise.resolve(data.slice(0, data.length - 3)) // Reverse of mock encrypt
        ),
        VeridexSDK: class { },
        createSDK: vi.fn(),
    };
});

describe('SessionKeyManager', () => {
    let manager: SessionKeyManager;

    beforeEach(() => {
        manager = new SessionKeyManager();
        // Clear localStorage for clean tests
        if (typeof localStorage !== 'undefined') {
            localStorage.clear();
        }
    });

    describe('Session Creation', () => {
        it('should create a session with valid configuration', async () => {
            const masterKey = {
                credentialId: 'test-credential-123',
                publicKeyX: BigInt('0x' + '1'.repeat(64)),
                publicKeyY: BigInt('0x' + '2'.repeat(64)),
                keyHash: '0x' + 'a'.repeat(64),
            };

            const config: SessionKeyConfig = {
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
                expiryTimestamp: Date.now() + 60 * 60 * 1000, // 1 hour
                allowedChains: [30],
            };

            const session = await manager.createSession(masterKey, config);

            expect(session).toBeDefined();
            expect(session.keyHash).toBeDefined();
            expect(session.publicKey).toBeDefined();
            expect(session.config).toEqual(config);
            expect(session.metadata.totalSpentUSD).toBe(0);
            expect(session.metadata.dailySpentUSD).toBe(0);
            expect(session.masterKeyHash).toBe(masterKey.keyHash);
        });

        it('should reject session with daily limit <= 0', async () => {
            const masterKey = {
                credentialId: 'test-credential',
                publicKeyX: BigInt(1),
                publicKeyY: BigInt(2),
                keyHash: '0xabc',
            };

            const config: SessionKeyConfig = {
                dailyLimitUSD: 0,
                perTransactionLimitUSD: 10,
                expiryTimestamp: Date.now() + 3600000,
                allowedChains: [30],
            };

            await expect(manager.createSession(masterKey, config)).rejects.toThrow(AgentPaymentError);
        });

        it('should reject session with perTxLimit > dailyLimit', async () => {
            const masterKey = {
                credentialId: 'test-credential',
                publicKeyX: BigInt(1),
                publicKeyY: BigInt(2),
                keyHash: '0xabc',
            };

            const config: SessionKeyConfig = {
                dailyLimitUSD: 50,
                perTransactionLimitUSD: 100, // Exceeds daily
                expiryTimestamp: Date.now() + 3600000,
                allowedChains: [30],
            };

            await expect(manager.createSession(masterKey, config)).rejects.toThrow(
                /Per-transaction limit cannot exceed daily limit/
            );
        });

        it('should reject session with expired timestamp', async () => {
            const masterKey = {
                credentialId: 'test-credential',
                publicKeyX: BigInt(1),
                publicKeyY: BigInt(2),
                keyHash: '0xabc',
            };

            const config: SessionKeyConfig = {
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
                expiryTimestamp: Date.now() - 1000, // In the past
                allowedChains: [30],
            };

            await expect(manager.createSession(masterKey, config)).rejects.toThrow(
                /Session expiry must be in the future/
            );
        });

        it('should reject session with duration > 24 hours', async () => {
            const masterKey = {
                credentialId: 'test-credential',
                publicKeyX: BigInt(1),
                publicKeyY: BigInt(2),
                keyHash: '0xabc',
            };

            const config: SessionKeyConfig = {
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
                expiryTimestamp: Date.now() + 25 * 60 * 60 * 1000, // 25 hours
                allowedChains: [30],
            };

            await expect(manager.createSession(masterKey, config)).rejects.toThrow(
                /Session duration cannot exceed 24 hours/
            );
        });
    });

    describe('Limit Checking', () => {
        it('should allow transaction within limits', () => {
            const session: StoredSession = createMockSession({
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
            });

            const result = manager.checkLimits(session, 20);

            expect(result.allowed).toBe(true);
            expect(result.remainingDailyLimitUSD).toBe(80);
        });

        it('should reject transaction exceeding per-tx limit', () => {
            const session = createMockSession({
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
            });

            const result = manager.checkLimits(session, 30);

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('per-transaction limit');
        });

        it('should reject transaction exceeding daily limit', () => {
            const session = createMockSession({
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 50,
                dailySpentUSD: 80,
            });

            const result = manager.checkLimits(session, 25);

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('daily limit');
        });

        it('should reject transactions for expired sessions', () => {
            const session = createMockSession({
                expiryTimestamp: Date.now() - 1000, // Expired
            });

            const result = manager.checkLimits(session, 10);

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('expired');
        });
    });

    describe('Spending Recording', () => {
        it('should update spending after transaction', async () => {
            const session = createMockSession({
                dailyLimitUSD: 100,
                dailySpentUSD: 0,
                totalSpentUSD: 0,
            });

            await manager.recordSpending(session, 25);

            expect(session.metadata.dailySpentUSD).toBe(25);
            expect(session.metadata.totalSpentUSD).toBe(25);
        });

        it('should accumulate spending correctly', async () => {
            const session = createMockSession({
                dailyLimitUSD: 100,
                dailySpentUSD: 20,
                totalSpentUSD: 50,
            });

            await manager.recordSpending(session, 15);

            expect(session.metadata.dailySpentUSD).toBe(35);
            expect(session.metadata.totalSpentUSD).toBe(65);
        });
    });

    describe('Session Validity', () => {
        it('should return true for valid session', () => {
            const session = createMockSession({
                expiryTimestamp: Date.now() + 3600000,
            });

            expect(manager.isSessionValid(session)).toBe(true);
        });

        it('should return false for expired session', () => {
            const session = createMockSession({
                expiryTimestamp: Date.now() - 1000,
            });

            expect(manager.isSessionValid(session)).toBe(false);
        });
    });
});

// Property-based tests
describe('SessionKeyManager - Property Tests', () => {
    describe('Property 1: Session Key Spending Limits Are Never Exceeded', () => {
        it('should never allow spending beyond daily limit', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 10000 }), // dailyLimit
                    fc.integer({ min: 1, max: 10000 }), // perTxLimit
                    fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 20 }), // transactions
                    (dailyLimit, perTxLimit, transactions) => {
                        const actualPerTxLimit = Math.min(perTxLimit, dailyLimit);
                        const manager = new SessionKeyManager();
                        const session = createMockSession({
                            dailyLimitUSD: dailyLimit,
                            perTransactionLimitUSD: actualPerTxLimit,
                            dailySpentUSD: 0,
                        });

                        let totalApproved = 0;
                        for (const tx of transactions) {
                            const result = manager.checkLimits(session, tx);
                            if (result.allowed) {
                                totalApproved += tx;
                                session.metadata.dailySpentUSD += tx;
                            }
                        }

                        // Total approved should never exceed daily limit
                        expect(totalApproved).toBeLessThanOrEqual(dailyLimit);
                    }
                ),
                { numRuns: 100 }
            );
        });

        it('should never allow single transaction beyond per-tx limit', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 10000 }), // dailyLimit
                    fc.integer({ min: 1, max: 1000 }), // perTxLimit
                    fc.integer({ min: 1, max: 2000 }), // transaction
                    (dailyLimit, perTxLimit, transaction) => {
                        const actualPerTxLimit = Math.min(perTxLimit, dailyLimit);
                        const manager = new SessionKeyManager();
                        const session = createMockSession({
                            dailyLimitUSD: dailyLimit,
                            perTransactionLimitUSD: actualPerTxLimit,
                        });

                        const result = manager.checkLimits(session, transaction);

                        // If approved, transaction must be within per-tx limit
                        if (result.allowed) {
                            expect(transaction).toBeLessThanOrEqual(actualPerTxLimit);
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });
    });

    describe('Property 2: Expired Sessions Reject All Operations', () => {
        it('should reject all transactions after expiry', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 1000 }), // transaction amount
                    (amount) => {
                        const manager = new SessionKeyManager();
                        const session = createMockSession({
                            dailyLimitUSD: 10000,
                            perTransactionLimitUSD: 5000,
                            expiryTimestamp: Date.now() - 1, // Just expired
                        });

                        const result = manager.checkLimits(session, amount);
                        expect(result.allowed).toBe(false);
                    }
                ),
                { numRuns: 50 }
            );
        });
    });
});

// Helper function to create mock sessions
function createMockSession(overrides: Partial<StoredSession & {
    dailyLimitUSD?: number;
    perTransactionLimitUSD?: number;
    expiryTimestamp?: number;
    dailySpentUSD?: number;
    totalSpentUSD?: number;
}> = {}): StoredSession {
    const {
        dailyLimitUSD = 100,
        perTransactionLimitUSD = 25,
        expiryTimestamp = Date.now() + 3600000,
        dailySpentUSD = 0,
        totalSpentUSD = 0,
        ...rest
    } = overrides;

    return {
        keyHash: '0x' + 'a'.repeat(64),
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
        ...rest,
    };
}
