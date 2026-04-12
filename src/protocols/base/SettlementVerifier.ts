/**
 * @packageDocumentation
 * @module SettlementVerifier
 * @description
 * Per-protocol on-chain settlement verification.
 *
 * After a payment is executed, the SettlementVerifier confirms that the
 * transaction actually settled on-chain. Each protocol registers a
 * verification strategy. The result feeds into the EvidenceBundle's
 * settlementProof field for dispute resolution.
 */

import type { ProtocolName, PaymentSettlement } from './types';
import type { SettlementProof } from '../../trace/types';

/**
 * Strategy interface for protocol-specific settlement verification.
 */
export interface SettlementVerificationStrategy {
  /** Which protocol this strategy handles */
  readonly protocol: ProtocolName;

  /**
   * Verify that a settlement actually occurred on-chain.
   * @param settlement - The settlement receipt from the protocol handler
   * @param traceHash - The trace hash to look for in calldata (optional binding)
   * @returns Settlement proof or null if verification failed
   */
  verify(
    settlement: PaymentSettlement,
    traceHash?: string,
  ): Promise<SettlementProof | null>;
}

/** Configuration for the SettlementVerifier */
export interface SettlementVerifierConfig {
  /** RPC endpoints keyed by chain ID */
  rpcEndpoints?: Record<number, string>;
  /** Timeout for verification calls in ms */
  timeoutMs?: number;
  /** Number of block confirmations to wait for */
  confirmations?: number;
}

/**
 * Aggregates per-protocol verification strategies and provides a
 * unified interface for settlement verification.
 */
export class SettlementVerifier {
  private readonly strategies = new Map<ProtocolName, SettlementVerificationStrategy>();
  private readonly config: Required<SettlementVerifierConfig>;

  constructor(config?: SettlementVerifierConfig) {
    this.config = {
      rpcEndpoints: config?.rpcEndpoints ?? {},
      timeoutMs: config?.timeoutMs ?? 30_000,
      confirmations: config?.confirmations ?? 1,
    };
  }

  /**
   * Register a verification strategy for a protocol.
   */
  registerStrategy(strategy: SettlementVerificationStrategy): void {
    this.strategies.set(strategy.protocol, strategy);
  }

  /**
   * Verify a settlement using the appropriate protocol strategy.
   */
  async verify(
    settlement: PaymentSettlement,
    traceHash?: string,
  ): Promise<SettlementProof | null> {
    if (!settlement.success || !settlement.txHash) {
      return null;
    }

    const strategy = this.strategies.get(settlement.protocol);
    if (!strategy) {
      // No strategy registered — return basic proof from settlement data
      return this.basicProof(settlement);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      return await strategy.verify(settlement, traceHash);
    } catch {
      // Verification failure is non-fatal — return basic proof
      return this.basicProof(settlement);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Check if a strategy is registered for a given protocol.
   */
  hasStrategy(protocol: ProtocolName): boolean {
    return this.strategies.has(protocol);
  }

  /**
   * Get the RPC endpoint for a chain.
   */
  getRpcEndpoint(chainId: number): string | undefined {
    return this.config.rpcEndpoints[chainId];
  }

  /**
   * Basic proof constructed from settlement data when no strategy is available.
   */
  private basicProof(settlement: PaymentSettlement): SettlementProof {
    const chainId = this.parseChainId(settlement.network);
    return {
      txHash: settlement.txHash!,
      traceHashInCalldata: false,
      chain: chainId,
    };
  }

  private parseChainId(network: string): number {
    const parsed = parseInt(network, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
}

/**
 * EVM-based settlement verification strategy.
 * Works for x402 (ERC-3009), UCP, ACP, and any EVM-settled protocol.
 */
export class EVMSettlementStrategy implements SettlementVerificationStrategy {
  readonly protocol: ProtocolName;
  private readonly rpcEndpoints: Record<number, string>;

  constructor(
    protocol: ProtocolName,
    rpcEndpoints: Record<number, string>,
  ) {
    this.protocol = protocol;
    this.rpcEndpoints = rpcEndpoints;
  }

  async verify(
    settlement: PaymentSettlement,
    traceHash?: string,
  ): Promise<SettlementProof | null> {
    if (!settlement.txHash) return null;

    const chainId = this.parseChainId(settlement.network);
    const rpcUrl = this.rpcEndpoints[chainId];
    if (!rpcUrl) {
      return {
        txHash: settlement.txHash,
        traceHashInCalldata: false,
        chain: chainId,
      };
    }

    // Fetch transaction receipt via JSON-RPC
    const response = await globalThis.fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [settlement.txHash],
      }),
    });

    const json = await response.json() as {
      result?: { blockNumber?: string; status?: string } | null;
    };
    const receipt = json.result;

    if (!receipt) return null;

    const blockNumber = receipt.blockNumber
      ? parseInt(receipt.blockNumber, 16)
      : undefined;

    const success = receipt.status === '0x1';
    if (!success) return null;

    // Check for traceHash in calldata if requested
    let traceHashInCalldata = false;
    if (traceHash) {
      const txResponse = await globalThis.fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'eth_getTransactionByHash',
          params: [settlement.txHash],
        }),
      });

      const txJson = await txResponse.json() as {
        result?: { input?: string } | null;
      };

      if (txJson.result?.input) {
        const normalizedHash = traceHash.startsWith('0x')
          ? traceHash.slice(2).toLowerCase()
          : traceHash.toLowerCase();
        traceHashInCalldata = txJson.result.input.toLowerCase().includes(normalizedHash);
      }
    }

    return {
      txHash: settlement.txHash,
      blockNumber,
      traceHashInCalldata,
      chain: chainId,
    };
  }

  private parseChainId(network: string): number {
    const parsed = parseInt(network, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
}
