import { StarknetClient as CoreStarknetClient, StarknetClientConfig as CoreStarknetClientConfig } from '@veridex/sdk';
import { BaseAgentChainClient } from './ChainClient';

/**
 * Agent-specific Starknet chain client.
 */
export class StarknetChainClient extends BaseAgentChainClient {
    private starknetCore: CoreStarknetClient;

    constructor(config: CoreStarknetClientConfig) {
        const core = new CoreStarknetClient(config);
        super(core);
        this.starknetCore = core;
    }

    override async getNativeTokenPriceUSD(): Promise<number> {
        // STRK price
        return 0.5;
    }

    override async getTokenPriceUSD(tokenAddress: string): Promise<number> {
        // USDC on Starknet
        return 1.0;
    }

    getClient() {
        return this.starknetCore.getProvider();
    }
}
