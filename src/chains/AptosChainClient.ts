import { AptosClient as CoreAptosClient, AptosClientConfig as CoreAptosClientConfig } from '@veridex/sdk';
import { BaseAgentChainClient } from './ChainClient';

/**
 * Agent-specific Aptos chain client.
 */
export class AptosChainClient extends BaseAgentChainClient {
    private aptosCore: CoreAptosClient;

    constructor(config: CoreAptosClientConfig) {
        const core = new CoreAptosClient(config);
        super(core);
        this.aptosCore = core;
    }

    override async getNativeTokenPriceUSD(): Promise<number> {
        // APT price
        return 10.0;
    }

    override async getTokenPriceUSD(tokenAddress: string): Promise<number> {
        // USDC on Aptos
        return 1.0;
    }

    getClient() {
        return this.aptosCore.getClient();
    }
}
