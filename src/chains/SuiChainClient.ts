/**
 * @packageDocumentation
 * @module SuiChainClient
 * @description
 * Agent adapter for the Sui blockchain (Move VM).
 * 
 * Extends the core SDK to support agent operations on Sui.
 */
import { SuiClient as CoreSuiClient, SuiClientConfig as CoreSuiClientConfig } from '@veridex/sdk/chains/sui';
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


    getClient() {
        return this.suiCore.getClient();
    }
}
