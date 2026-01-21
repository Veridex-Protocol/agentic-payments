/**
 * @packageDocumentation
 * @module EVMChainClient
 * @description
 * Agent adapter for Ethereum Virtual Machine (EVM) compatible chains.
 * 
 * This class wraps the core `EVMClient` to provide agent-specific functionality for
 * chains like Ethereum, Base, Optimism, and Arbitrum.
 * 
 * Capabilities:
 * - Uses `ethers.js` for RPC interactions.
 * - Supports EIP-712 signing for x402 payments.
 * - Integration with Pyth Oracle for pricing.
 */
import { EVMClient as CoreEVMClient, EVMClientConfig as CoreEVMClientConfig } from '@veridex/sdk/chains/evm';
import { BaseAgentChainClient } from './ChainClient';
import { ethers } from 'ethers';

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
     * Helper to get the underlying ethers provider
     */
    getProvider(): ethers.BrowserProvider | ethers.JsonRpcProvider {
        return this.evmCore.getProvider();
    }
}
