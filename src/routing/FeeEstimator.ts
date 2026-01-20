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
