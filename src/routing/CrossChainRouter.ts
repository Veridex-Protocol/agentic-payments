/**
 * @packageDocumentation
 * @module CrossChainRouter
 * @description
 * Intelligent routing for multi-chain payments.
 * 
 * The Router is responsible for finding the most efficient path for a payment to reach its destination.
 * It considers:
 * - **Direct Transfers**: If the agent already holds funds on the target chain.
 * - **Wormhole Bridging**: If funds need to be moved across chains.
 * - **DEX Swaps**: If token conversion is needed (via {@link DEXAggregator}).
 * 
 * It optimizes for either **Speed** (fastest finality) or **Cost** (lowest fees).
 */

import {
  VeridexSDK,
  createSDK,
  ChainName,
} from '@veridex/sdk';
import type { PortfolioBalance, TokenBalance } from '@veridex/sdk';
import { StoredSession } from '../session/SessionStorage';
import { ethers } from 'ethers';
import { AgentChainClient } from '../chains/ChainClient';
import { ChainClientFactory } from '../chains/ChainClientFactory';

// Wormhole chain ID to chain name mapping
const WORMHOLE_ID_TO_CHAIN: Record<number, ChainName> = {
  2: 'ethereum',
  30: 'base',
  23: 'arbitrum',
  24: 'optimism',
  5: 'polygon',
  1: 'solana',
  22: 'aptos',
  21: 'sui',
  // Testnets
  10002: 'ethereum',
  10004: 'base',
};

/**
 * Step in a payment route
 */
export interface RouteStep {
  /** Type of operation */
  action: 'transfer' | 'bridge' | 'swap';
  /** Source chain (Wormhole ID) */
  sourceChain: number;
  /** Target chain (Wormhole ID) */
  targetChain: number;
  /** Token address on source chain */
  token: string;
  /** Amount to transfer */
  amount: bigint;
  /** Protocol to use (e.g., 'veridex', 'wormhole') */
  protocol: string;
  /** Estimated time in seconds */
  estimatedTimeSeconds: number;
  /** Estimated fee in USD */
  estimatedFeeUSD: number;
}

/**
 * Complete payment route
 */
export interface PaymentRoute {
  /** Whether a valid route was found */
  success: boolean;
  /** Source chain for the payment */
  sourceChain: number;
  /** Target chain for delivery */
  targetChain: number;
  /** Total amount including fees */
  totalAmount: bigint;
  /** Total fees across all steps */
  totalFees: bigint;
  /** Estimated total time in seconds */
  estimatedTimeSeconds: number;
  /** Individual steps in the route */
  steps: RouteStep[];
  /** Error message if no route found */
  error?: string;
}

/**
 * Route finding options
 */
export interface RouteOptions {
  /** Prefer speed over cost */
  preferSpeed?: boolean;
  /** Maximum acceptable fee in USD */
  maxFeeUSD?: number;
  /** Maximum acceptable time in seconds */
  maxTimeSeconds?: number;
  /** Specific token to use for payment */
  preferredToken?: string;
}

export class CrossChainRouter {
  private sdkCache: Map<number, VeridexSDK> = new Map();
  private clientCache: Map<number, AgentChainClient> = new Map();

  constructor(
    private coreSDK?: VeridexSDK,
    private relayerUrl?: string,
    private relayerApiKey?: string,
    private testnet: boolean = true
  ) { }

  /**
   * Find the optimal route for a payment.
   * 
   * @param session - Active session for the payment
   * @param targetChain - Target chain for delivery (Wormhole ID)
   * @param amount - Amount to transfer (in smallest unit)
   * @param token - Token address or symbol
   * @param options - Route finding options
   * @returns Optimal payment route
   */
  async findOptimalRoute(
    session: StoredSession,
    targetChain: number,
    amount: bigint,
    token: string,
    options: RouteOptions = {}
  ): Promise<PaymentRoute> {
    // Get user's address from session
    const userAddress = ethers.computeAddress(session.publicKey);

    // Check if target chain is in allowed chains
    if (!session.config.allowedChains.includes(targetChain)) {
      return {
        success: false,
        sourceChain: 0,
        targetChain,
        totalAmount: amount,
        totalFees: 0n,
        estimatedTimeSeconds: 0,
        steps: [],
        error: `Target chain ${targetChain} is not in allowed chains for this session`,
      };
    }

    // Get multi-chain balances
    const balances = await this.getMultiChainBalances(userAddress, session.config.allowedChains);

    // Find chains with sufficient balance
    const viableChains = this.findViableSourceChains(balances, token, amount);

    if (viableChains.length === 0) {
      return {
        success: false,
        sourceChain: 0,
        targetChain,
        totalAmount: amount,
        totalFees: 0n,
        estimatedTimeSeconds: 0,
        steps: [],
        error: 'Insufficient balance on any allowed chain',
      };
    }

    // Calculate routes from each viable chain
    const routes = await Promise.all(
      viableChains.map((chain) =>
        this.calculateRoute(chain, targetChain, amount, token, options)
      )
    );

    // Select optimal route
    const validRoutes = routes.filter((r) => r.success);
    if (validRoutes.length === 0) {
      return {
        success: false,
        sourceChain: 0,
        targetChain,
        totalAmount: amount,
        totalFees: 0n,
        estimatedTimeSeconds: 0,
        steps: [],
        error: 'No valid routes found',
      };
    }

    // Sort by preference (cost or speed)
    const sortedRoutes = this.sortRoutes(validRoutes, options);
    return sortedRoutes[0];
  }

  /**
   * Get balances across multiple chains.
   */
  private async getMultiChainBalances(
    address: string,
    chainIds: number[]
  ): Promise<Map<number, TokenBalance[]>> {
    const balances = new Map<number, TokenBalance[]>();

    // Use core SDK's multi-chain balance fetching if available
    if (this.coreSDK) {
      try {
        // getMultiChainBalances returns PortfolioBalance[]
        const portfolios = await this.coreSDK.balance.getMultiChainBalances(address, chainIds);
        for (const portfolio of portfolios) {
          if (chainIds.includes(portfolio.wormholeChainId)) {
            balances.set(portfolio.wormholeChainId, portfolio.tokens);
          }
        }
        return balances;
      } catch (e) {
        console.warn('[CrossChainRouter] Multi-chain balance fetch failed, falling back to individual queries', e);
      }
    }

    // Fallback: Query each chain individually
    await Promise.all(
      chainIds.map(async (chainId) => {
        try {
          const sdk = await this.getSDKForChain(chainId);
          if (sdk) {
            const result = await sdk.balance.getPortfolioBalance(chainId, address);
            balances.set(chainId, result.tokens);
          }
        } catch (e) {
          console.warn(`[CrossChainRouter] Failed to get balance for chain ${chainId}`, e);
        }
      })
    );

    return balances;
  }

  /**
   * Find chains with sufficient balance for the payment.
   */
  private findViableSourceChains(
    balances: Map<number, TokenBalance[]>,
    token: string,
    amount: bigint
  ): number[] {
    const viableChains: number[] = [];

    for (const [chainId, tokens] of balances) {
      const tokenBalance = tokens.find(
        (t) =>
          t.token.address.toLowerCase() === token.toLowerCase() ||
          t.token.symbol.toUpperCase() === token.toUpperCase()
      );

      if (tokenBalance && tokenBalance.balance >= amount) {
        viableChains.push(chainId);
      }
    }

    return viableChains;
  }

  /**
   * Calculate a route from source to target chain.
   */
  private async calculateRoute(
    sourceChain: number,
    targetChain: number,
    amount: bigint,
    token: string,
    options: RouteOptions
  ): Promise<PaymentRoute> {
    // Same chain - direct transfer
    if (sourceChain === targetChain) {
      return {
        success: true,
        sourceChain,
        targetChain,
        totalAmount: amount,
        totalFees: BigInt(10000), // ~0.01 USDC for gas
        estimatedTimeSeconds: 2, // L2 is fast
        steps: [
          {
            action: 'transfer',
            sourceChain,
            targetChain,
            token,
            amount,
            protocol: 'veridex',
            estimatedTimeSeconds: 2,
            estimatedFeeUSD: 0.01,
          },
        ],
      };
    }

    // Cross-chain - need bridge
    const bridgeFee = await this.estimateBridgeFee(sourceChain, targetChain, amount);
    const estimatedTime = this.estimateBridgeTime(sourceChain, targetChain);

    return {
      success: true,
      sourceChain,
      targetChain,
      totalAmount: amount + bridgeFee,
      totalFees: bridgeFee,
      estimatedTimeSeconds: estimatedTime,
      steps: [
        {
          action: 'bridge',
          sourceChain,
          targetChain,
          token,
          amount,
          protocol: 'wormhole',
          estimatedTimeSeconds: estimatedTime,
          estimatedFeeUSD: Number(bridgeFee) / 1e6, // Assuming USDC
        },
      ],
    };
  }

  /**
   * Estimate bridge fee between chains.
   */
  private async estimateBridgeFee(
    sourceChain: number,
    targetChain: number,
    amount: bigint
  ): Promise<bigint> {
    // Try to get real fee from SDK
    if (this.coreSDK) {
      try {
        const fees = await this.coreSDK.getBridgeFees({
          sourceChain,
          destinationChain: targetChain,
          recipient: ethers.ZeroAddress, // Placeholder - actual recipient not needed for fee estimation
          amount,
          token: 'native',
        });
        return fees.messageFee + fees.relayerFee + fees.sourceGas;
      } catch (e) {
        console.warn('[CrossChainRouter] Failed to get bridge fees', e);
      }
    }

    // Fallback estimates based on chain types
    const evmChains = [2, 30, 23, 24, 5, 4, 6];
    const isEvmToEvm = evmChains.includes(sourceChain) && evmChains.includes(targetChain);

    if (isEvmToEvm) {
      return BigInt(500000); // ~$0.50 for EVM-to-EVM
    }

    // Cross-VM bridges are more expensive
    return BigInt(2000000); // ~$2.00
  }

  /**
   * Estimate bridge time in seconds.
   */
  private estimateBridgeTime(sourceChain: number, targetChain: number): number {
    // Wormhole finality times
    const evmChains = [2, 30, 23, 24, 5];
    const isEvmToEvm = evmChains.includes(sourceChain) && evmChains.includes(targetChain);

    if (isEvmToEvm) {
      // EVM-to-EVM via Wormhole: ~60-120 seconds
      return 90;
    }

    // Cross-VM: longer finality
    if (sourceChain === 1 || targetChain === 1) {
      // Solana involved: ~10-30 seconds
      return 30;
    }

    // Default
    return 120;
  }

  /**
   * Sort routes by preference.
   */
  private sortRoutes(routes: PaymentRoute[], options: RouteOptions): PaymentRoute[] {
    return routes.sort((a, b) => {
      if (options.preferSpeed) {
        // Sort by time first, then fees
        if (a.estimatedTimeSeconds !== b.estimatedTimeSeconds) {
          return a.estimatedTimeSeconds - b.estimatedTimeSeconds;
        }
        return Number(a.totalFees - b.totalFees);
      } else {
        // Sort by fees first, then time
        const feeDiff = Number(a.totalFees - b.totalFees);
        if (feeDiff !== 0) return feeDiff;
        return a.estimatedTimeSeconds - b.estimatedTimeSeconds;
      }
    });
  }

  /**
   * Get or create an SDK instance for a specific chain.
   */
  private async getSDKForChain(chainId: number): Promise<VeridexSDK | null> {
    if (this.sdkCache.has(chainId)) {
      return this.sdkCache.get(chainId)!;
    }

    const chainName = WORMHOLE_ID_TO_CHAIN[chainId];
    if (!chainName) {
      console.warn(`[CrossChainRouter] Unknown chain ID: ${chainId}`);
      return null;
    }

    try {
      const sdk = createSDK(chainName, {
        network: this.testnet ? 'testnet' : 'mainnet',
        relayerUrl: this.relayerUrl,
        relayerApiKey: this.relayerApiKey,
      });
      this.sdkCache.set(chainId, sdk);
      return sdk;
    } catch (e) {
      console.warn(`[CrossChainRouter] Failed to create SDK for chain ${chainName}`, e);
      return null;
    }
  }

  /**
   * Get or create an AgentChainClient for a specific chain.
   */
  private async getClientForChain(chainId: number): Promise<AgentChainClient | null> {
    if (this.clientCache.has(chainId)) {
      return this.clientCache.get(chainId)!;
    }

    const chainName = WORMHOLE_ID_TO_CHAIN[chainId];
    if (!chainName) {
      return null;
    }

    try {
      const client = ChainClientFactory.createClient(
        chainName,
        this.testnet ? 'testnet' : 'mainnet'
      );
      this.clientCache.set(chainId, client);
      return client;
    } catch (e) {
      console.warn(`[CrossChainRouter] Failed to create client for chain ${chainName}`, e);
      return null;
    }
  }

  /**
   * Execute a payment route.
   * 
   * @param route - Route to execute
   * @param recipient - Payment recipient address
   * @param signer - Signer for transactions
   * @returns Transaction hash of the final step
   */
  async executeRoute(
    route: PaymentRoute,
    recipient: string,
    signer: ethers.Wallet
  ): Promise<{ txHash: string; success: boolean }> {
    if (!route.success || route.steps.length === 0) {
      throw new Error('Invalid route');
    }

    // Execute each step
    for (const step of route.steps) {
      const sdk = await this.getSDKForChain(step.sourceChain);
      if (!sdk) {
        throw new Error(`No SDK available for chain ${step.sourceChain}`);
      }

      if (step.action === 'transfer') {
        const result = await sdk.transfer({
          recipient,
          amount: step.amount,
          token: step.token,
          targetChain: step.targetChain,
        }, signer);

        return { txHash: result.transactionHash, success: true };
      } else if (step.action === 'bridge') {
        const result = await sdk.bridgeWithTracking({
          sourceChain: step.sourceChain,
          destinationChain: step.targetChain,
          recipient,
          amount: step.amount,
          token: step.token,
        }, signer);

        // BridgeResult/CrossChainResult usually has sourceTxHash
        return { txHash: (result as any).sourceTxHash || (result as any).transactionHash, success: true };
      }
    }

    throw new Error('No executable steps in route');
  }
}
