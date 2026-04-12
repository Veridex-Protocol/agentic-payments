/**
 * @packageDocumentation
 * @module StarknetChainClient
 * @description
 * Agent adapter for the Starknet Validity Rollup.
 * 
 * This class handles the specific requirements of Starknet's Account Abstraction model (SNIP-12).
 * It ensures that agent signatures generated for x402 payments are compatible with
 * Starknet's native account contracts.
 * 
 * Key Features:
 * - Generates SNIP-12 typed data signatures.
 * - Manages nonce abstraction for Starknet accounts.
 * - Interfaces with Starknet RPC providers.
 */
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
