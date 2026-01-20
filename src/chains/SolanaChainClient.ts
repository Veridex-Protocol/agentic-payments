import { SolanaClient as CoreSolanaClient, SolanaClientConfig as CoreSolanaClientConfig } from '@veridex/sdk';
import { BaseAgentChainClient } from './ChainClient';

/**
 * Agent-specific Solana chain client.
 * Extends the core Solana client with agent-centric features.
 */
export class SolanaChainClient extends BaseAgentChainClient {
    private solanaCore: CoreSolanaClient;

    constructor(config: CoreSolanaClientConfig) {
        const core = new CoreSolanaClient(config);
        super(core);
        this.solanaCore = core;
    }

    /**
     * Get the USD price of SOL.
     */
    override async getNativeTokenPriceUSD(): Promise<number> {
        // TODO: In production, query Pyth or similar
        return 100.0;
    }

    /**
     * Get the USD price of a specific token on Solana.
     */
    override async getTokenPriceUSD(tokenAddress: string): Promise<number> {
        // USDC on Solana
        if (tokenAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
            return 1.0;
        }
        return 1.0;
    }

    /**
     * Helper to get the underlying connection
     */
    getConnection() {
        return this.solanaCore.getConnection();
    }
}
