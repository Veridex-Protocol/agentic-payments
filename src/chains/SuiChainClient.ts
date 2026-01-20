import { SuiClient as CoreSuiClient, SuiClientConfig as CoreSuiClientConfig } from '@veridex/sdk';
import { BaseAgentChainClient } from './ChainClient';

/**
 * Agent-specific Sui chain client.
 */
export class SuiChainClient extends BaseAgentChainClient {
    private suiCore: CoreSuiClient;

    constructor(config: CoreSuiClientConfig) {
        const core = new CoreSuiClient(config);
        super(core);
        this.suiCore = core;
    }

    override async getNativeTokenPriceUSD(): Promise<number> {
        // SUI price
        return 2.0;
    }

    override async getTokenPriceUSD(tokenAddress: string): Promise<number> {
        // USDC on Sui
        return 1.0;
    }

    getClient() {
        return this.suiCore.getClient();
    }
}
