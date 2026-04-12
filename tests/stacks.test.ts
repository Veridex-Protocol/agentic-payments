/**
 * Stacks Agent SDK Unit Tests
 *
 * Tests for StacksChainClient, StacksSpendingTracker,
 * and StacksFacilitatorAdapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @veridex/sdk/chains/stacks before importing
vi.mock('@veridex/sdk/chains/stacks', () => ({
    StacksClient: vi.fn().mockImplementation((config: any) => ({
        getConfig: () => ({
            name: config.network === 'mainnet' ? 'Stacks' : 'Stacks Testnet',
            chainId: config.network === 'mainnet' ? 1 : 2147483648,
            wormholeChainId: config.wormholeChainId || 60,
            isEvm: false,
            rpcUrl: config.rpcUrl,
            explorerUrl: config.network === 'mainnet'
                ? 'https://explorer.hiro.so'
                : 'https://explorer.hiro.so/?chain=testnet',
            contracts: { hub: config.spokeContractAddress },
        }),
        getNonce: vi.fn().mockResolvedValue(0n),
        getMessageFee: vi.fn().mockResolvedValue(0n),
        buildTransferPayload: vi.fn().mockResolvedValue('0x'),
        buildExecutePayload: vi.fn().mockResolvedValue('0x'),
        buildBridgePayload: vi.fn().mockResolvedValue('0x'),
        dispatch: vi.fn().mockRejectedValue(new Error('Direct dispatch not supported')),
        getVaultAddress: vi.fn().mockResolvedValue(null),
        computeVaultAddress: vi.fn().mockReturnValue('ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.veridex-vault'),
        vaultExists: vi.fn().mockResolvedValue(false),
        createVault: vi.fn().mockRejectedValue(new Error('Use relayer')),
        estimateVaultCreationGas: vi.fn().mockResolvedValue(10000n),
        getFactoryAddress: vi.fn().mockReturnValue(undefined),
        getImplementationAddress: vi.fn().mockReturnValue(undefined),
        getVaultStxBalance: vi.fn().mockResolvedValue(5000000n),
        getVaultSbtcBalance: vi.fn().mockResolvedValue(100000n),
        getNativeBalance: vi.fn().mockResolvedValue(10000000n),
        isProtocolPaused: vi.fn().mockResolvedValue(false),
        getCurrentBlockHeight: vi.fn().mockResolvedValue(150000),
        checkSessionActive: vi.fn().mockResolvedValue(true),
        getRemainingBudget: vi.fn().mockResolvedValue(1000000n),
    })),
    StacksClientConfig: {},
}));

// Mock PythOracle
vi.mock('../src/oracle/PythOracle', () => ({
    PythOracle: {
        getInstance: vi.fn().mockReturnValue({
            getNativeTokenPrice: vi.fn().mockResolvedValue(0.55),
            getPrice: vi.fn().mockImplementation((token: string) => {
                if (token === 'BTC') return Promise.resolve(62000);
                if (token === 'STX') return Promise.resolve(0.55);
                return Promise.resolve(0);
            }),
        }),
    },
}));

import { StacksChainClient } from '../src/chains/StacksChainClient';
import { StacksSpendingTracker } from '../src/session/StacksSpendingTracker';
import { StacksFacilitatorAdapter } from '../src/x402/adapters/StacksFacilitatorAdapter';

// ============================================================================
// StacksChainClient Tests
// ============================================================================

describe('StacksChainClient', () => {
    let client: StacksChainClient;

    beforeEach(() => {
        client = new StacksChainClient({
            wormholeChainId: 60,
            rpcUrl: 'https://api.testnet.hiro.so',
            spokeContractAddress: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.veridex-spoke',
            network: 'testnet',
        });
    });

    describe('Configuration', () => {
        it('should create client with correct config', () => {
            const config = client.getConfig();
            expect(config.name).toContain('Stacks');
            expect(config.wormholeChainId).toBe(60);
            expect(config.isEvm).toBe(false);
        });

        it('should expose underlying StacksClient', () => {
            const core = client.getStacksClient();
            expect(core).toBeDefined();
        });
    });

    describe('Pricing', () => {
        it('should get STX price in USD', async () => {
            const price = await client.getNativeTokenPriceUSD();
            expect(price).toBe(0.55);
        });

        it('should get sBTC price in USD (BTC-pegged)', async () => {
            const price = await client.getTokenPriceUSD('sbtc-token');
            expect(price).toBe(62000);
        });

        it('should return default price for unknown tokens', async () => {
            const price = await client.getTokenPriceUSD('unknown-token');
            expect(price).toBe(1.0);
        });

        it('should detect sBTC by various identifiers', async () => {
            const price1 = await client.getTokenPriceUSD('sbtc-token');
            const price2 = await client.getTokenPriceUSD('SBTC');
            const price3 = await client.getTokenPriceUSD('sBTC');
            expect(price1).toBe(62000);
            expect(price2).toBe(62000);
            expect(price3).toBe(62000);
        });
    });

    describe('Vault Queries', () => {
        it('should get vault STX balance', async () => {
            const balance = await client.getVaultStxBalance('0xdeadbeef');
            expect(balance).toBe(5000000n);
        });

        it('should get vault sBTC balance', async () => {
            const balance = await client.getVaultSbtcBalance('0xdeadbeef');
            expect(balance).toBe(100000n);
        });

        it('should get native STX balance', async () => {
            const balance = await client.getNativeBalance('ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM');
            expect(balance).toBe(10000000n);
        });
    });

    describe('Protocol Status', () => {
        it('should check if protocol is paused', async () => {
            const paused = await client.isProtocolPaused();
            expect(paused).toBe(false);
        });

        it('should get current block height', async () => {
            const height = await client.getCurrentBlockHeight();
            expect(height).toBe(150000);
        });
    });

    describe('Session Queries', () => {
        it('should check session active status', async () => {
            const active = await client.checkSessionActive('0xkey', '0xsession');
            expect(active).toBe(true);
        });

        it('should get remaining budget', async () => {
            const budget = await client.getRemainingBudget('0xkey', '0xsession');
            expect(budget).toBe(1000000n);
        });
    });

    describe('ChainClient Interface', () => {
        it('should implement getMessageFee returning 0', async () => {
            const fee = await client.getMessageFee();
            expect(fee).toBe(0n);
        });

        it('should implement getNonce', async () => {
            const nonce = await client.getNonce('0xdeadbeef');
            expect(nonce).toBe(0n);
        });

        it('should return undefined for getFactoryAddress', () => {
            expect(client.getFactoryAddress()).toBeUndefined();
        });

        it('should return undefined for getImplementationAddress', () => {
            expect(client.getImplementationAddress()).toBeUndefined();
        });
    });
});

// ============================================================================
// StacksSpendingTracker Tests
// ============================================================================

describe('StacksSpendingTracker', () => {
    let tracker: StacksSpendingTracker;

    beforeEach(() => {
        tracker = new StacksSpendingTracker();
    });

    describe('STX Conversions', () => {
        it('should convert microSTX to USD', async () => {
            // 1 STX = 1,000,000 microSTX, price = $0.55
            const usd = await tracker.stxToUSD(1000000n);
            expect(usd).toBeCloseTo(0.55, 2);
        });

        it('should convert 5 STX to USD', async () => {
            const usd = await tracker.stxToUSD(5000000n);
            expect(usd).toBeCloseTo(2.75, 2);
        });

        it('should convert 0 microSTX to $0', async () => {
            const usd = await tracker.stxToUSD(0n);
            expect(usd).toBe(0);
        });

        it('should convert USD to microSTX', async () => {
            const microSTX = await tracker.usdToMicroSTX(1.10);
            // $1.10 / $0.55 = 2 STX = 2,000,000 microSTX
            expect(microSTX).toBe(2000000n);
        });
    });

    describe('sBTC Conversions', () => {
        it('should convert satoshis to USD', async () => {
            // 1 sBTC = 100,000,000 sats, price = $62,000
            const usd = await tracker.sbtcToUSD(100000000n);
            expect(usd).toBeCloseTo(62000, 0);
        });

        it('should convert 0.001 sBTC to USD', async () => {
            const usd = await tracker.sbtcToUSD(100000n);
            expect(usd).toBeCloseTo(62, 0);
        });

        it('should convert USD to satoshis', async () => {
            const sats = await tracker.usdToSatoshis(62);
            // $62 / $62,000 = 0.001 BTC = 100,000 sats
            expect(sats).toBe(100000n);
        });
    });

    describe('estimatePaymentUSD', () => {
        it('should estimate STX payment', async () => {
            const usd = await tracker.estimatePaymentUSD('2000000', 'STX');
            expect(usd).toBeCloseTo(1.10, 2);
        });

        it('should estimate sBTC payment', async () => {
            const usd = await tracker.estimatePaymentUSD('100000', 'sBTC');
            expect(usd).toBeCloseTo(62, 0);
        });

        it('should estimate SBTC payment (uppercase)', async () => {
            const usd = await tracker.estimatePaymentUSD('100000', 'SBTC');
            expect(usd).toBeCloseTo(62, 0);
        });

        it('should return 0 for unknown asset', async () => {
            const usd = await tracker.estimatePaymentUSD('1000', 'UNKNOWN');
            expect(usd).toBe(0);
        });
    });
});

// ============================================================================
// StacksFacilitatorAdapter Tests
// ============================================================================

describe('StacksFacilitatorAdapter', () => {
    let adapter: StacksFacilitatorAdapter;

    beforeEach(() => {
        adapter = new StacksFacilitatorAdapter({
            facilitatorUrl: 'https://x402-facilitator.example.com',
            network: 'testnet',
        });
    });

    describe('canHandle', () => {
        it('should handle stacks:1 network', () => {
            const result = adapter.canHandle({
                network: 'stacks:1',
                amount: '1000000',
                token: 'STX',
                recipient: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
                chain: 60,
                scheme: 'exact',
                original: {} as any,
            });
            expect(result).toBe(true);
        });

        it('should handle stacks:2147483648 network', () => {
            const result = adapter.canHandle({
                network: 'stacks:2147483648',
                amount: '1000000',
                token: 'STX',
                recipient: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
                chain: 60,
                scheme: 'exact',
                original: {} as any,
            });
            expect(result).toBe(true);
        });

        it('should not handle non-stacks networks', () => {
            const result = adapter.canHandle({
                network: 'base-mainnet',
                amount: '1000000',
                token: 'USDC',
                recipient: '0x1234',
                chain: 30,
                scheme: 'exact',
                original: {} as any,
            });
            expect(result).toBe(false);
        });

        it('should not handle empty network', () => {
            const result = adapter.canHandle({
                network: '',
                amount: '1000000',
                token: 'STX',
                recipient: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
                chain: 60,
                scheme: 'exact',
                original: {} as any,
            });
            expect(result).toBe(false);
        });
    });

    describe('getNetworkCAIP2', () => {
        it('should return testnet CAIP-2', () => {
            expect(adapter.getNetworkCAIP2()).toBe('stacks:2147483648');
        });

        it('should return mainnet CAIP-2', () => {
            const mainnetAdapter = new StacksFacilitatorAdapter({
                facilitatorUrl: 'https://x402-facilitator.example.com',
                network: 'mainnet',
            });
            expect(mainnetAdapter.getNetworkCAIP2()).toBe('stacks:1');
        });
    });

    describe('getCapabilities', () => {
        it('should return supported assets', () => {
            const caps = adapter.getCapabilities();
            expect(caps.assets).toContain('STX');
            expect(caps.assets).toContain('sBTC');
        });

        it('should return correct network', () => {
            const caps = adapter.getCapabilities();
            expect(caps.network).toBe('stacks:2147483648');
        });
    });

    describe('getSBTCContract', () => {
        it('should return sBTC contract info', () => {
            const contract = adapter.getSBTCContract();
            expect(contract.name).toBe('sbtc-token');
            expect(contract.address).toBeDefined();
        });
    });

    describe('buildPayment', () => {
        it('should reject unsupported tokens', async () => {
            await expect(
                adapter.buildPayment(
                    {
                        network: 'stacks:2147483648',
                        amount: '1000000',
                        token: 'UNSUPPORTED',
                        recipient: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
                        chain: 60,
                        scheme: 'exact',
                        original: {} as any,
                    },
                    'deadbeef1234567890'
                )
            ).rejects.toThrow('not supported on Stacks');
        });
    });
});
