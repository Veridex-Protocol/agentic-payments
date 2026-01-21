/**
 * @packageDocumentation
 * @module ChainClient
 * @description
 * Defines the unified interface for Agent-specific blockchain interactions.
 * 
 * This module provides the `AgentChainClient` interface and base classes that abstract
 * the differences between various blockchains (EVM, Solana, Starknet, etc.).
 * It extends the core SDK's chain clients with agent-specific capabilities, such as:
 * - Real-time token pricing (USD) via Pyth Network.
 * - Gas estimation for agent operations.
 * - Unified transaction payload building.
 */
import { ChainClient as CoreChainClient, ChainConfig } from '@veridex/sdk';
import { PythOracle } from '../oracle/PythOracle';

/**
 * Unified interface for agent-specific chain client operations.
 * Wraps the core Veridex ChainClient and adds agent-specific needs.
 */
export interface AgentChainClient extends CoreChainClient {
    /**
     * Get the USD price of the native token on this chain.
     */
    getNativeTokenPriceUSD(): Promise<number>;

    /**
     * Get the USD price of a specific token on this chain.
     */
    getTokenPriceUSD(tokenAddress: string): Promise<number>;
}

/**
 * Common base for all agent chain clients.
 */
export abstract class BaseAgentChainClient implements AgentChainClient {
    constructor(protected coreClient: CoreChainClient) { }

    // Delegate core methods to the wrapped client
    getConfig(): ChainConfig { return this.coreClient.getConfig(); }
    async getNonce(userKeyHash: string): Promise<bigint> { return this.coreClient.getNonce(userKeyHash); }
    async getMessageFee(): Promise<bigint> { return this.coreClient.getMessageFee(); }
    async buildTransferPayload(params: any): Promise<string> { return this.coreClient.buildTransferPayload(params); }
    async buildExecutePayload(params: any): Promise<string> { return this.coreClient.buildExecutePayload(params); }
    async buildBridgePayload(params: any): Promise<string> { return this.coreClient.buildBridgePayload(params); }
    async dispatch(sig: any, x: bigint, y: bigint, target: number, pay: string, nonce: bigint, signer: any): Promise<any> {
        return this.coreClient.dispatch(sig, x, y, target, pay, nonce, signer);
    }
    async getVaultAddress(userKeyHash: string): Promise<string | null> { return this.coreClient.getVaultAddress(userKeyHash); }
    computeVaultAddress(userKeyHash: string): string { return this.coreClient.computeVaultAddress(userKeyHash); }
    async vaultExists(userKeyHash: string): Promise<boolean> { return this.coreClient.vaultExists(userKeyHash); }
    async createVault(userKeyHash: string, signer: any): Promise<any> { return this.coreClient.createVault(userKeyHash, signer); }
    async estimateVaultCreationGas(userKeyHash: string): Promise<bigint> { return this.coreClient.estimateVaultCreationGas(userKeyHash); }
    getFactoryAddress(): string | undefined { return this.coreClient.getFactoryAddress(); }
    getImplementationAddress(): string | undefined { return this.coreClient.getImplementationAddress(); }

    // New agent-specific methods
    async getNativeTokenPriceUSD(): Promise<number> {
        const config = this.getConfig();
        const price = await PythOracle.getInstance().getNativeTokenPrice(config.name);
        if (price > 0) return price;

        console.warn(`[BaseAgentChainClient] Failed to get native price for ${config.name}, returning fallback.`);
        return 1.0; // Fallback
    }

    async getTokenPriceUSD(tokenAddress: string): Promise<number> {
        // TODO: Implement token address to Feed ID mapping
        // For now, check if it's USDC or similar known tokens?
        // Or simply fail/return default.
        return 1.0;
    }
}
