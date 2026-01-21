/**
 * @packageDocumentation
 * @module SolanaChainClient
 * @description
 * Agent adapter for the Solana blockchain.
 * 
 * This class extends the core `SolanaClient` to enable agentic operations on Solana.
 * 
 * Key Features:
 * - Manages Solana specific transaction instructions.
 * - Handles SPL Token transfers.
 * - Integrates with Wormhole for cross-chain messages.
 */
import { SolanaClient as CoreSolanaClient, SolanaClientConfig as CoreSolanaClientConfig } from '@veridex/sdk/chains/solana';
import { BaseAgentChainClient } from './ChainClient';

/**
 * Agent-specific Solana chain client.
 * Extends the core Solana client with agent-centric features.
 */
export class SolanaChainClient extends BaseAgentChainClient {
    private solanaCore: CoreSolanaClient;

    constructor(config: CoreSolanaClientConfig) {
        const core = new CoreSolanaClient(config);
        super(core);
        this.solanaCore = core;
    }


    /**
     * Helper to get the underlying connection
     */
    getConnection() {
        return this.solanaCore.getConnection();
    }
}
