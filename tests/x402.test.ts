/**
 * x402 Protocol Tests
 * 
 * Tests for x402 payment parsing, signing, and flow handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { PaymentParser } from '../src/x402/PaymentParser';
import { PaymentSigner } from '../src/x402/PaymentSigner';
import { StoredSession } from '../src/session/SessionStorage';
import { ethers } from 'ethers';

describe('PaymentParser', () => {
    let parser: PaymentParser;

    beforeEach(() => {
        parser = new PaymentParser();
    });

    describe('Header Parsing', () => {
        it('should parse valid PAYMENT-REQUIRED header', () => {
            const requirement = {
                paymentRequirements: [{
                    scheme: 'exact',
                    network: 'base-mainnet',
                    maxAmountRequired: '1000000', // 1 USDC
                    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                    payTo: '0x0000000000000000000000000000000000000001',
                }],
            };

            const encoded = Buffer.from(JSON.stringify(requirement)).toString('base64');
            const headers = { 'payment-required': encoded };

            const result = parser.parseHeaders(headers);

            expect(result).toBeDefined();
            expect(result!.amount).toBe('1000000');
            expect(result!.token).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
            expect(result!.recipient).toBe('0x0000000000000000000000000000000000000001');
            expect(result!.chain).toBe(30); // Base
            expect(result!.scheme).toBe('exact');
        });

        it('should handle uppercase header names', () => {
            const requirement = {
                paymentRequirements: [{
                    scheme: 'exact',
                    network: 'base',
                    maxAmountRequired: '500000',
                    asset: 'USDC',
                    payTo: '0x0000000000000000000000000000000000000123',
                }],
            };

            const encoded = Buffer.from(JSON.stringify(requirement)).toString('base64');
            const headers = { 'PAYMENT-REQUIRED': encoded };

            const result = parser.parseHeaders(headers);
            expect(result).toBeDefined();
            expect(result!.amount).toBe('500000');
        });

        it('should return null for missing header', () => {
            const result = parser.parseHeaders({});
            expect(result).toBeNull();
        });

        it('should return null for invalid base64', () => {
            const headers = { 'payment-required': 'not-valid-base64!!!' };
            const result = parser.parseHeaders(headers);
            expect(result).toBeNull();
        });

        it('should return null for invalid JSON', () => {
            const encoded = Buffer.from('not json').toString('base64');
            const headers = { 'payment-required': encoded };
            const result = parser.parseHeaders(headers);
            expect(result).toBeNull();
        });
    });

    describe('Network Mapping', () => {
        it('should map ethereum-mainnet to chain ID 2', () => {
            const requirement = createPaymentRequirement('ethereum-mainnet');
            const encoded = Buffer.from(JSON.stringify(requirement)).toString('base64');
            const result = parser.parseHeaders({ 'payment-required': encoded });

            expect(result!.chain).toBe(2);
        });

        it('should map base-mainnet to chain ID 30', () => {
            const requirement = createPaymentRequirement('base-mainnet');
            const encoded = Buffer.from(JSON.stringify(requirement)).toString('base64');
            const result = parser.parseHeaders({ 'payment-required': encoded });

            expect(result!.chain).toBe(30);
        });

        it('should map solana-mainnet to chain ID 1', () => {
            const requirement = createPaymentRequirement('solana-mainnet');
            const encoded = Buffer.from(JSON.stringify(requirement)).toString('base64');
            const result = parser.parseHeaders({ 'payment-required': encoded });

            expect(result!.chain).toBe(1);
        });

        it('should handle numeric network IDs', () => {
            const requirement = createPaymentRequirement('8453'); // Base EVM chain ID
            const encoded = Buffer.from(JSON.stringify(requirement)).toString('base64');
            const result = parser.parseHeaders({ 'payment-required': encoded });

            expect(result!.chain).toBe(30); // Should map to Wormhole Base ID
        });
    });

    describe('Amount Parsing', () => {
        it('should parse integer amounts', () => {
            const amount = parser.parseAmount('1000000', 6);
            expect(amount).toBe(1000000n);
        });

        it('should parse decimal amounts', () => {
            const amount = parser.parseAmount('1.5', 6);
            expect(amount).toBe(1500000n);
        });

        it('should handle decimals correctly for 18 decimal tokens', () => {
            const amount = parser.parseAmount('1.0', 18);
            expect(amount).toBe(1000000000000000000n);
        });
    });

    describe('Amount Formatting', () => {
        it('should format whole numbers', () => {
            const formatted = parser.formatAmount(1000000n, 6);
            expect(formatted).toBe('1');
        });

        it('should format decimal amounts', () => {
            const formatted = parser.formatAmount(1500000n, 6);
            expect(formatted).toBe('1.5');
        });

        it('should handle small amounts', () => {
            const formatted = parser.formatAmount(1n, 6);
            expect(formatted).toBe('0.000001');
        });
    });
});

describe('PaymentSigner', () => {
    let signer: PaymentSigner;
    let testSession: StoredSession;
    let testWallet: ethers.Wallet;

    beforeEach(() => {
        signer = new PaymentSigner();
        testWallet = ethers.Wallet.createRandom();
        testSession = {
            keyHash: '0x' + 'a'.repeat(64),
            encryptedPrivateKey: testWallet.privateKey, // Unencrypted for tests
            publicKey: testWallet.signingKey.publicKey,
            config: {
                dailyLimitUSD: 100,
                perTransactionLimitUSD: 25,
                expiryTimestamp: Date.now() + 3600000,
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
            masterKeyHash: '0x' + 'b'.repeat(64),
        };
    });

    describe('Signature Generation', () => {
        it('should generate a valid EIP-712 signature', async () => {
            const request = {
                amount: '1000000',
                token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                recipient: '0x0000000000000000000000000000000000000001',
                chain: 30,
                network: 'base-mainnet',
                scheme: 'exact' as const,
                original: {} as any,
            };

            const result = await signer.sign(request, testSession);

            expect(result.signature).toBeDefined();
            expect(result.signature.length).toBe(132); // 0x + 65 bytes hex
            expect(result.nonce).toBeDefined();
            expect(result.deadline).toBeGreaterThan(Date.now() / 1000);
            expect(result.paymentPayload).toBeDefined();
        });

        it('should include correct deadline in signature', async () => {
            const now = Math.floor(Date.now() / 1000);
            const request = {
                amount: '1000000',
                token: 'USDC',
                recipient: '0x0000000000000000000000000000000000000123',
                chain: 30,
                network: 'base',
                scheme: 'exact' as const,
                original: {} as any,
            };

            const result = await signer.sign(request, testSession);

            // Default deadline should be 5 minutes from now
            expect(result.deadline).toBeGreaterThanOrEqual(now + 280);
            expect(result.deadline).toBeLessThanOrEqual(now + 320);
        });

        it('should use provided deadline if specified', async () => {
            const customDeadline = Math.floor(Date.now() / 1000) + 600;
            const request = {
                amount: '1000000',
                token: 'USDC',
                recipient: '0x0000000000000000000000000000000000000123',
                chain: 30,
                network: 'base',
                scheme: 'exact' as const,
                deadline: customDeadline,
                original: {} as any,
            };

            const result = await signer.sign(request, testSession);

            expect(result.deadline).toBe(customDeadline);
        });

        it('should generate unique nonces', async () => {
            const request = {
                amount: '1000000',
                token: 'USDC',
                recipient: '0x0000000000000000000000000000000000000123',
                chain: 30,
                network: 'base',
                scheme: 'exact' as const,
                original: {} as any,
            };

            const result1 = await signer.sign(request, testSession);
            const result2 = await signer.sign(request, testSession);

            expect(result1.nonce).not.toBe(result2.nonce);
        });
    });

    describe('Signature Verification', () => {
        it('should verify its own signatures', async () => {
            const request = {
                amount: '1000000',
                token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                recipient: '0x0000000000000000000000000000000000000001',
                chain: 30,
                network: 'base',
                scheme: 'exact' as const,
                original: {} as any,
            };

            const result = await signer.sign(request, testSession);

            // Decode the payload to get the authorization
            const payload = JSON.parse(Buffer.from(result.paymentPayload, 'base64').toString());
            const authorization = payload.payload.authorization;

            const isValid = signer.verifySignature(
                result.signature,
                authorization,
                testWallet.address,
                8453, // Base EVM chain ID
                '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // Base USDC address
            );

            expect(isValid).toBe(true);
        });

        it('should reject signatures from different signers', async () => {
            const request = {
                amount: '1000000',
                token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
                recipient: '0x0000000000000000000000000000000000000123',
                chain: 30,
                network: 'base',
                scheme: 'exact' as const,
                original: {} as any,
            };

            const result = await signer.sign(request, testSession);
            const payload = JSON.parse(Buffer.from(result.paymentPayload, 'base64').toString());
            const authorization = payload.payload.authorization;

            const wrongAddress = '0x0000000000000000000000000000000000000000';
            const isValid = signer.verifySignature(
                result.signature,
                authorization,
                wrongAddress,
                8453,
                '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // Base USDC address
            );

            expect(isValid).toBe(false);
        });
    });
});

// Property-based tests
describe('x402 - Property Tests', () => {
    describe('Property 5: Nonce Sequencing Prevents Replay Attacks', () => {
        it('should never generate duplicate nonces in sequence', () => {
            fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 2, max: 50 }), // number of signatures to generate
                    async (count) => {
                        const signer = new PaymentSigner();
                        const wallet = ethers.Wallet.createRandom();
                        const session: StoredSession = {
                            keyHash: '0x' + 'a'.repeat(64),
                            encryptedPrivateKey: wallet.privateKey,
                            publicKey: wallet.signingKey.publicKey,
                            config: {
                                dailyLimitUSD: 100,
                                perTransactionLimitUSD: 25,
                                expiryTimestamp: Date.now() + 3600000,
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
                            masterKeyHash: '0x' + 'b'.repeat(64),
                        };

                        const request = {
                            amount: '1000000',
                            token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
                            recipient: '0x0000000000000000000000000000000000000123',
                            chain: 30,
                            network: 'base',
                            scheme: 'exact' as const,
                            original: {} as any,
                        };

                        const nonces = new Set<string>();
                        for (let i = 0; i < count; i++) {
                            const result = await signer.sign(request, session);
                            expect(nonces.has(result.nonce)).toBe(false);
                            nonces.add(result.nonce);
                        }

                        expect(nonces.size).toBe(count);
                    }
                ),
                { numRuns: 20 }
            );
        });
    });
});

// Helper functions
function createPaymentRequirement(network: string) {
    return {
        paymentRequirements: [{
            scheme: 'exact',
            network,
            maxAmountRequired: '1000000',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            payTo: '0x0000000000000000000000000000000000000001',
        }],
    };
}
