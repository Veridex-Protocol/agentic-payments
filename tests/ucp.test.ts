/**
 * UCP Module Unit Tests
 * 
 * Tests for PaymentTokenizer, CredentialProvider, and CapabilityNegotiator.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentTokenizer } from '../src/ucp/PaymentTokenizer';
import { UCPCredentialProvider } from '../src/ucp/CredentialProvider';
import { CapabilityNegotiator } from '../src/ucp/CapabilityNegotiator';
import { StoredSession } from '../src/session/SessionStorage';

// Helper to create mock sessions
function createMockSession(overrides: Partial<{
    keyHash: string;
    dailyLimitUSD: number;
    perTransactionLimitUSD: number;
    expiryTimestamp: number;
}> = {}): StoredSession {
    const {
        keyHash = '0x' + 'a'.repeat(64),
        dailyLimitUSD = 100,
        perTransactionLimitUSD = 25,
        expiryTimestamp = Date.now() + 3600000,
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
            totalSpentUSD: 0,
            dailySpentUSD: 0,
            dailyResetAt: Date.now() + 86400000,
            transactionCount: 0,
        },
        masterKeyHash: '0x' + 'd'.repeat(64),
    };
}

describe('PaymentTokenizer', () => {
    let tokenizer: PaymentTokenizer;

    beforeEach(() => {
        tokenizer = new PaymentTokenizer();
    });

    describe('tokenize', () => {
        it('should generate a valid token from a session', async () => {
            const session = createMockSession();
            const token = await tokenizer.tokenize(session);

            expect(token).toBeDefined();
            expect(token.token).toBeDefined();
            expect(token.keyHash).toBe(session.keyHash);
            expect(token.limits.dailyLimitUSD).toBe(session.config.dailyLimitUSD);
            expect(token.limits.perTransactionLimitUSD).toBe(session.config.perTransactionLimitUSD);
            expect(token.expiresAt).toBeLessThanOrEqual(session.config.expiryTimestamp);
        });

        it('should respect custom TTL', async () => {
            const session = createMockSession({ expiryTimestamp: Date.now() + 3600000 });
            const customTtl = 5 * 60 * 1000; // 5 minutes
            const token = await tokenizer.tokenize(session, customTtl);

            const expectedExpiry = Date.now() + customTtl;
            expect(token.expiresAt).toBeLessThanOrEqual(expectedExpiry + 100); // Allow 100ms tolerance
        });

        it('should not exceed session expiry', async () => {
            const shortExpiry = Date.now() + 60000; // 1 minute
            const session = createMockSession({ expiryTimestamp: shortExpiry });
            const longTtl = 3600000; // 1 hour

            const token = await tokenizer.tokenize(session, longTtl);

            expect(token.expiresAt).toBeLessThanOrEqual(shortExpiry);
        });
    });

    describe('validate', () => {
        it('should validate a valid token', async () => {
            const session = createMockSession();
            const token = await tokenizer.tokenize(session);

            const result = tokenizer.validate(token.token);

            expect(result.valid).toBe(true);
            expect(result.session).toBeDefined();
            expect(result.session?.keyHash).toBe(session.keyHash);
        });

        it('should reject malformed tokens', () => {
            const result = tokenizer.validate('not-a-valid-token');

            expect(result.valid).toBe(false);
            expect(result.reason).toBeDefined();
        });

        it('should reject tokens not in cache', () => {
            // Create a structurally valid token that's not in the cache
            const fakeTokenData = {
                keyHash: '0xfake',
                type: 'VERIDEX_SESSION_TOKEN',
                limits: { dailyLimitUSD: 100, perTransactionLimitUSD: 25 },
                expiresAt: Date.now() + 60000,
                nonce: '0x123',
            };
            const fakeToken = Buffer.from(JSON.stringify(fakeTokenData)).toString('base64url');

            const result = tokenizer.validate(fakeToken);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('not found');
        });
    });

    describe('revoke', () => {
        it('should revoke a token', async () => {
            const session = createMockSession();
            const token = await tokenizer.tokenize(session);

            // Token should be valid
            expect(tokenizer.validate(token.token).valid).toBe(true);

            // Revoke
            const revoked = tokenizer.revoke(token.token);
            expect(revoked).toBe(true);

            // Token should now be invalid
            expect(tokenizer.validate(token.token).valid).toBe(false);
        });

        it('should return false for non-existent token', () => {
            const revoked = tokenizer.revoke('non-existent-token');
            expect(revoked).toBe(false);
        });
    });

    describe('revokeAllForSession', () => {
        it('should revoke all tokens for a session', async () => {
            const session = createMockSession({ keyHash: '0xsession1' });

            // Create multiple tokens
            const token1 = await tokenizer.tokenize(session);
            const token2 = await tokenizer.tokenize(session);

            // All should be valid
            expect(tokenizer.validate(token1.token).valid).toBe(true);
            expect(tokenizer.validate(token2.token).valid).toBe(true);

            // Revoke all for session
            const count = tokenizer.revokeAllForSession('0xsession1');
            expect(count).toBe(2);

            // All should now be invalid
            expect(tokenizer.validate(token1.token).valid).toBe(false);
            expect(tokenizer.validate(token2.token).valid).toBe(false);
        });
    });

    describe('refresh', () => {
        it('should refresh a valid token', async () => {
            const session = createMockSession();
            const oldToken = await tokenizer.tokenize(session);

            const newToken = await tokenizer.refresh(oldToken.token, session);

            expect(newToken).not.toBeNull();
            expect(newToken?.token).not.toBe(oldToken.token);
            expect(newToken?.keyHash).toBe(session.keyHash);

            // Old token should be invalid
            expect(tokenizer.validate(oldToken.token).valid).toBe(false);

            // New token should be valid
            expect(tokenizer.validate(newToken!.token).valid).toBe(true);
        });

        it('should return null for invalid token', async () => {
            const session = createMockSession();
            const result = await tokenizer.refresh('invalid-token', session);
            expect(result).toBeNull();
        });
    });
});

describe('CapabilityNegotiator', () => {
    let negotiator: CapabilityNegotiator;

    beforeEach(() => {
        negotiator = new CapabilityNegotiator();
    });

    it('should return intersection of requested and supported capabilities', () => {
        const requested = ['checkout', 'identity_linking', 'orders', 'unknown_capability'];
        const result = negotiator.negotiate(requested);

        expect(result.agreed).toContain('checkout');
        expect(result.agreed).not.toContain('unknown_capability');
    });

    it('should handle empty requested capabilities', () => {
        const result = negotiator.negotiate([]);
        expect(result.agreed).toHaveLength(0);
    });

    it('should return all supported when requesting all', () => {
        const requested = ['checkout', 'identity_linking', 'orders'];
        const result = negotiator.negotiate(requested);

        expect(result.agreed.length).toBeGreaterThan(0);
    });
});

describe('UCPCredentialProvider', () => {
    it('should generate a UCP profile', () => {
        // UCPCredentialProvider requires a SessionKeyManager
        // For this test, we'll mock it
        const mockSessionManager = {
            checkLimits: vi.fn().mockReturnValue({ allowed: true }),
            recordSpending: vi.fn(),
        } as any;

        const provider = new UCPCredentialProvider(mockSessionManager);
        const profile = provider.getProfile();

        expect(profile).toBeDefined();
        expect(profile.version).toBeDefined();
        expect(profile.capabilities).toBeDefined();
        expect(Array.isArray(profile.capabilities)).toBe(true);
    });

    it('should include expected capabilities in profile', () => {
        const mockSessionManager = {
            checkLimits: vi.fn().mockReturnValue({ allowed: true }),
            recordSpending: vi.fn(),
        } as any;

        const provider = new UCPCredentialProvider(mockSessionManager);
        const profile = provider.getProfile();

        expect(profile.capabilities).toContain('checkout');
    });
});
