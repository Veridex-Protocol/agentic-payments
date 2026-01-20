import { EVMClient as CoreEVMClient, EVMClientConfig as CoreEVMClientConfig } from '@veridex/sdk';
import { BaseAgentChainClient } from './ChainClient';

/**
 * Agent-specific EVM chain client.
 * Extends the core EVM client with agent-centric features like price estimation.
 */
export class EVMChainClient extends BaseAgentChainClient {
    private evmCore: CoreEVMClient;

    constructor(config: CoreEVMClientConfig) {
        const core = new CoreEVMClient(config);
        super(core);
        this.evmCore = core;
    }

    /**
     * Get the USD price of the native token (ETH, BNB, etc.) on this chain.
     */
    override async getNativeTokenPriceUSD(): Promise<number> {
        // TODO: In a production-grade implementation, this should query a real-time price oracle
        // like Chainlink (on-chain) or a secure off-chain aggregator (via relayer).
        // For now, we return a fallback based on the common chain names.
        const config = this.getConfig();
        const name = config.name.toLowerCase();

        if (name.includes('ethereum')) return 2500.0;
        if (name.includes('base')) return 2500.0; // Base uses ETH
        if (name.includes('optimism')) return 2500.0;
        if (name.includes('arbitrum')) return 2500.0;
        if (name.includes('polygon')) return 0.8;
        if (name.includes('bnb')) return 300.0;

        return 1.0;
    }

    /**
     * Get the USD price of a specific token on this chain.
     */
    override async getTokenPriceUSD(tokenAddress: string): Promise<number> {
        // USDC, USDT, DAI are roughly 1.0
        // This is a placeholder for a real price discovery service integration (Task 8.4)
        const stablecoins = [
            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
            '0x06eFdBFf2a1452c93C2A3943339D1d450a638aB9', // USDC on Arbitrum Sepolia
            '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // USDC on Sepolia
        ];

        if (stablecoins.some(s => s.toLowerCase() === tokenAddress.toLowerCase())) {
            return 1.0;
        }

        // Fallback or query price service
        return 1.0;
    }

    /**
     * Helper to get the underlying ethers provider
     */
    getProvider() {
        return this.evmCore.getProvider();
    }
}
