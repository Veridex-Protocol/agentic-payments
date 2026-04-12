/**
 * @packageDocumentation
 * @module AptosChainClient
 * @description
 * Agent adapter for the Aptos blockchain (Move VM).
 * 
 * Extends the core SDK to support agent operations on Aptos.
 */
import { AptosClient as CoreAptosClient, AptosClientConfig as CoreAptosClientConfig } from '@veridex/sdk/chains/aptos';
import { BaseAgentChainClient } from './ChainClient';
import { Aptos } from '@aptos-labs/ts-sdk';

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


    getClient(): Aptos {
        return this.aptosCore.getClient();
    }
}
