/**
 * @packageDocumentation
 * @module FeeEstimator
 * @description
 * Cross-chain fee estimation service.
 * 
 * Accurately calculating the cost of a cross-chain transaction is complex because it involves:
 * - Source chain gas fees.
 * - Wormhole/Relayer fees (in source token).
 * - Target chain redemption fees.
 * 
 * This module connects to the Veridex Relayer API to get real-time fee quotes.
 */
import { createRelayerClient, RelayerClient } from '@veridex/sdk';

export class FeeEstimator {
  private relayerClient?: RelayerClient;

  constructor(relayerUrl?: string, relayerApiKey?: string) {
    if (relayerUrl) {
      this.relayerClient = createRelayerClient({
        baseUrl: relayerUrl,
        apiKey: relayerApiKey
      });
    }
  }

  async estimateFee(sourceChain: number, targetChain: number): Promise<number> {
    if (sourceChain === targetChain) return 0.01;

    if (this.relayerClient) {
      try {
        const quote = await this.relayerClient.getFeeQuote(sourceChain, targetChain);
        // Convert bigint fee to USD (simplified)
        return Number(quote.feeInSourceToken) / 1e18;
      } catch (e) {
        console.error('Failed to get real fee quote', e);
      }
    }

    return 0.50; // Fallback $0.50 for cross-chain
  }
}
