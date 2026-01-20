import { StarknetClient as CoreStarknetClient, StarknetClientConfig as CoreStarknetClientConfig } from '@veridex/sdk/chains/starknet';
import { BaseAgentChainClient } from './ChainClient';
import { RpcProvider } from 'starknet';

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


    getClient(): RpcProvider {
        return this.starknetCore.getProvider();
    }
}
