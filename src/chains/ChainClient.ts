import { ChainClient as CoreChainClient, ChainConfig } from '@veridex/sdk';

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

    // New agent-specific methods (placeholders for now)
    async getNativeTokenPriceUSD(): Promise<number> {
        // In real implementation, query Pyth, Chainlink, or a price API
        return 1.0;
    }

    async getTokenPriceUSD(tokenAddress: string): Promise<number> {
        // In real implementation, query price API
        return 1.0;
    }
}
