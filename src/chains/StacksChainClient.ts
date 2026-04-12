/**
 * @packageDocumentation
 * @module StacksChainClient
 * @description
 * Agent adapter for the Stacks blockchain.
 *
 * This class wraps the core SDK's StacksClient with agent-specific capabilities:
 * - Real-time STX pricing via Pyth Network
 * - sBTC pricing (pegged to BTC)
 * - Stacks-specific balance queries for vault management
 *
 * Key Features:
 * - Native secp256r1 Passkey support (no ZK-proofs needed)
 * - Protocol-level Post-Conditions for spending safety
 * - Sponsored transactions for gasless agent operations
 */
import { StacksClient, StacksClientConfig } from '@veridex/sdk/chains/stacks';
import { BaseAgentChainClient } from './ChainClient';
import { PythOracle } from '../oracle/PythOracle';

/** Stacks-specific token identifiers */
const SBTC_TOKEN_IDENTIFIERS = ['sbtc-token', 'sbtc', 'sBTC', 'SBTC'];

/**
 * Agent-specific Stacks chain client.
 *
 * Extends BaseAgentChainClient with STX/sBTC pricing and
 * Stacks-specific vault balance queries.
 */
export class StacksChainClient extends BaseAgentChainClient {
    private stacksCore: StacksClient;

    constructor(config: StacksClientConfig) {
        const core = new StacksClient(config);
        super(core);
        this.stacksCore = core;
    }

    /**
     * Get the USD price of STX (native gas token).
     * Uses Pyth Network STX/USD feed with a $0.50 fallback.
     */
    async getNativeTokenPriceUSD(): Promise<number> {
        try {
            const oracle = PythOracle.getInstance();
            const price = await oracle.getNativeTokenPrice('Stacks');
            if (price > 0) return price;
        } catch {
            // Fall through to fallback
        }
        console.warn('[StacksChainClient] Failed to get STX price from Pyth, using fallback.');
        return 0.50;
    }

    /**
     * Get the USD price of a token on Stacks.
     * Supports sBTC (pegged to BTC price) and defaults to $1.0 for unknown tokens.
     */
    async getTokenPriceUSD(tokenAddress: string): Promise<number> {
        if (this.isSBTCToken(tokenAddress)) {
            try {
                const oracle = PythOracle.getInstance();
                const btcPrice = await oracle.getPrice('BTC');
                if (btcPrice > 0) return btcPrice;
            } catch {
                // Fall through to fallback
            }
            console.warn('[StacksChainClient] Failed to get BTC price for sBTC, using fallback.');
            return 60000;
        }
        return 1.0;
    }

    /**
     * Get the underlying StacksClient for direct Stacks-specific operations.
     */
    getStacksClient(): StacksClient {
        return this.stacksCore;
    }

    /**
     * Get vault STX balance for an identity.
     */
    async getVaultStxBalance(keyHash: string): Promise<bigint> {
        return this.stacksCore.getVaultStxBalance(keyHash);
    }

    /**
     * Get vault sBTC balance for an identity.
     */
    async getVaultSbtcBalance(keyHash: string): Promise<bigint> {
        return this.stacksCore.getVaultSbtcBalance(keyHash);
    }

    /**
     * Get native STX balance for an address.
     */
    async getNativeBalance(address: string): Promise<bigint> {
        return this.stacksCore.getNativeBalance(address);
    }

    /**
     * Check if the Stacks protocol is paused.
     */
    async isProtocolPaused(): Promise<boolean> {
        return this.stacksCore.isProtocolPaused();
    }

    /**
     * Get the current Stacks block height.
     * Useful for session expiry calculations.
     */
    async getCurrentBlockHeight(): Promise<number> {
        return this.stacksCore.getCurrentBlockHeight();
    }

    /**
     * Check if a session is active on the Stacks spoke contract.
     */
    async checkSessionActive(keyHash: string, sessionHash: string): Promise<boolean> {
        return this.stacksCore.checkSessionActive(keyHash, sessionHash);
    }

    /**
     * Get remaining spending budget for a session.
     */
    async getRemainingBudget(keyHash: string, sessionHash: string): Promise<bigint> {
        return this.stacksCore.getRemainingBudget(keyHash, sessionHash);
    }

    /**
     * Check if a token identifier refers to sBTC.
     */
    private isSBTCToken(tokenAddress: string): boolean {
        return SBTC_TOKEN_IDENTIFIERS.some(
            (id) => tokenAddress.toLowerCase().includes(id.toLowerCase())
        );
    }
}
