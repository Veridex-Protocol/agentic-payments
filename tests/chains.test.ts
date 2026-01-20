/**
 * Chain Client Unit Tests
 * 
 * Tests for multi-chain client implementations and the ChainClientFactory.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChainClientFactory } from '../src/chains/ChainClientFactory';
import { AgentChainClient } from '../src/chains/ChainClient';

// Mock the @veridex/sdk modules
vi.mock('@veridex/sdk', async () => {
    return {
        getChainPreset: vi.fn().mockImplementation((chain: string) => {
            const presets: Record<string, any> = {
                'base': {
                    type: 'evm',
                    testnet: {
                        chainId: 84532,
                        wormholeChainId: 30,
                        rpcUrl: 'https://sepolia.base.org',
                        name: 'Base Sepolia',
                        explorerUrl: 'https://sepolia.basescan.org',
                        contracts: {
                            hub: '0x1234567890123456789012345678901234567890',
                            wormholeCoreBridge: '0x0987654321098765432109876543210987654321',
                            vaultFactory: '0xfactory',
                            vaultImplementation: '0ximpl',
                            tokenBridge: '0xbridge',
                        },
                    },
                    mainnet: {
                        chainId: 8453,
                        wormholeChainId: 30,
                        rpcUrl: 'https://mainnet.base.org',
                        name: 'Base',
                        explorerUrl: 'https://basescan.org',
                        contracts: {
                            hub: '0x1234567890123456789012345678901234567890',
                            wormholeCoreBridge: '0x0987654321098765432109876543210987654321',
                            vaultFactory: '0xfactory',
                            vaultImplementation: '0ximpl',
                            tokenBridge: '0xbridge',
                        },
                    },
                },
                'solana': {
                    type: 'solana',
                    testnet: {
                        chainId: 0,
                        wormholeChainId: 1,
                        rpcUrl: 'https://api.devnet.solana.com',
                        name: 'Solana Devnet',
                        contracts: {
                            hub: 'programId123',
                            wormholeCoreBridge: 'wormhole123',
                            tokenBridge: 'tokenbridge123',
                        },
                    },
                    mainnet: {
                        chainId: 0,
                        wormholeChainId: 1,
                        rpcUrl: 'https://api.mainnet-beta.solana.com',
                        name: 'Solana',
                        contracts: {
                            hub: 'programId123',
                            wormholeCoreBridge: 'wormhole123',
                            tokenBridge: 'tokenbridge123',
                        },
                    },
                },
                'aptos': {
                    type: 'aptos',
                    testnet: {
                        chainId: 0,
                        wormholeChainId: 22,
                        rpcUrl: 'https://fullnode.testnet.aptoslabs.com',
                        name: 'Aptos Testnet',
                        contracts: {
                            hub: '0xmodule',
                            wormholeCoreBridge: '0xwormhole',
                            tokenBridge: '0xtokenbridge',
                        },
                    },
                    mainnet: {
                        chainId: 0,
                        wormholeChainId: 22,
                        rpcUrl: 'https://fullnode.mainnet.aptoslabs.com',
                        name: 'Aptos',
                        contracts: {
                            hub: '0xmodule',
                            wormholeCoreBridge: '0xwormhole',
                            tokenBridge: '0xtokenbridge',
                        },
                    },
                },
                'sui': {
                    type: 'sui',
                    testnet: {
                        chainId: 0,
                        wormholeChainId: 21,
                        rpcUrl: 'https://fullnode.testnet.sui.io',
                        name: 'Sui Testnet',
                        contracts: {
                            hub: '0xpackage',
                            wormholeCoreBridge: '0xwormhole',
                        },
                    },
                    mainnet: {
                        chainId: 0,
                        wormholeChainId: 21,
                        rpcUrl: 'https://fullnode.mainnet.sui.io',
                        name: 'Sui',
                        contracts: {
                            hub: '0xpackage',
                            wormholeCoreBridge: '0xwormhole',
                        },
                    },
                },
                'starknet': {
                    type: 'starknet',
                    testnet: {
                        chainId: 0,
                        wormholeChainId: 18,
                        rpcUrl: 'https://starknet-sepolia.public.blastapi.io',
                        name: 'Starknet Sepolia',
                        contracts: {
                            hub: '0xspoke',
                            wormholeCoreBridge: '0xbridge',
                        },
                    },
                    mainnet: {
                        chainId: 0,
                        wormholeChainId: 18,
                        rpcUrl: 'https://starknet-mainnet.public.blastapi.io',
                        name: 'Starknet',
                        contracts: {
                            hub: '0xspoke',
                            wormholeCoreBridge: '0xbridge',
                        },
                    },
                },
            };
            return presets[chain] || presets['base'];
        }),
        ChainName: {},
        NetworkType: {},
    };
});

// Mock chain-specific clients
vi.mock('@veridex/sdk/chains/evm', () => ({
    EVMClient: vi.fn().mockImplementation(() => ({
        getConfig: () => ({ name: 'Base Sepolia', chainId: 84532 }),
        getProvider: () => ({}),
    })),
    EVMClientConfig: {},
}));

vi.mock('@veridex/sdk/chains/solana', () => ({
    SolanaClient: vi.fn().mockImplementation(() => ({
        getConfig: () => ({ name: 'Solana Devnet' }),
        getConnection: () => ({}),
    })),
    SolanaClientConfig: {},
}));

vi.mock('@veridex/sdk/chains/aptos', () => ({
    AptosClient: vi.fn().mockImplementation(() => ({
        getConfig: () => ({ name: 'Aptos Testnet' }),
        getClient: () => ({}),
    })),
    AptosClientConfig: {},
}));

vi.mock('@veridex/sdk/chains/sui', () => ({
    SuiClient: vi.fn().mockImplementation(() => ({
        getConfig: () => ({ name: 'Sui Testnet' }),
        getClient: () => ({}),
    })),
    SuiClientConfig: {},
}));

vi.mock('@veridex/sdk/chains/starknet', () => ({
    StarknetClient: vi.fn().mockImplementation(() => ({
        getConfig: () => ({ name: 'Starknet Sepolia' }),
        getProvider: () => ({}),
    })),
    StarknetClientConfig: {},
}));

describe('ChainClientFactory', () => {
    describe('createClient', () => {
        it('should create EVM client for base chain', () => {
            const client = ChainClientFactory.createClient('base', 'testnet');
            expect(client).toBeDefined();
        });

        it('should create Solana client', () => {
            const client = ChainClientFactory.createClient('solana', 'testnet');
            expect(client).toBeDefined();
        });

        it('should create Aptos client', () => {
            const client = ChainClientFactory.createClient('aptos', 'testnet');
            expect(client).toBeDefined();
        });

        it('should create Sui client', () => {
            const client = ChainClientFactory.createClient('sui', 'testnet');
            expect(client).toBeDefined();
        });

        it('should create Starknet client', () => {
            const client = ChainClientFactory.createClient('starknet', 'testnet');
            expect(client).toBeDefined();
        });

        it('should use mainnet when specified', () => {
            const client = ChainClientFactory.createClient('base', 'mainnet');
            expect(client).toBeDefined();
        });

        it('should use custom RPC URL when provided', () => {
            const customRpc = 'https://custom-rpc.example.com';
            const client = ChainClientFactory.createClient('base', 'testnet', customRpc);
            expect(client).toBeDefined();
        });
    });
});

describe('AgentChainClient Interface', () => {
    it('should have getNativeTokenPriceUSD method', () => {
        const client = ChainClientFactory.createClient('base', 'testnet');
        expect(typeof client.getNativeTokenPriceUSD).toBe('function');
    });

    it('should have getTokenPriceUSD method', () => {
        const client = ChainClientFactory.createClient('base', 'testnet');
        expect(typeof client.getTokenPriceUSD).toBe('function');
    });
});
