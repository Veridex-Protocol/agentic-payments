/**
 * @packageDocumentation
 * @module ProtocolRegistry
 * @description
 * Protocol Capability Registry — formal declarations of what each protocol supports.
 *
 * Enables intelligent protocol selection based on required capabilities
 * (e.g., "I need refunds" → pick a protocol that supports refunds).
 * Replaces hard-coded protocol assumptions with a queryable registry.
 */

import type { ProtocolName } from './types';

/** Capabilities a protocol may support */
export type ProtocolCapability =
  | 'one_time_payment'
  | 'subscription'
  | 'streaming'
  | 'escrow'
  | 'refund'
  | 'partial_refund'
  | 'prepaid_session'
  | 'multi_token'
  | 'cross_chain'
  | 'gasless'
  | 'eip712_signing'
  | 'reputational_feedback'
  | 'metered_billing'
  | 'mandate_based';

/** Chain support declaration */
export interface ChainSupport {
  /** Wormhole chain ID */
  chainId: number;
  /** Human-readable chain name */
  name: string;
  /** Whether this is a testnet */
  testnet: boolean;
}

/** Protocol capability declaration */
export interface ProtocolCapabilities {
  /** Protocol name */
  readonly protocol: ProtocolName;
  /** Human-readable protocol label */
  readonly displayName: string;
  /** Set of supported capabilities */
  readonly capabilities: ReadonlySet<ProtocolCapability>;
  /** Supported chains */
  readonly chains: readonly ChainSupport[];
  /** Supported tokens (symbols). Empty = any token the chain supports. */
  readonly tokens: readonly string[];
  /** Minimum payment amount in USD (some protocols have minimums) */
  readonly minAmountUSD?: number;
  /** Maximum payment amount in USD (some protocols have caps) */
  readonly maxAmountUSD?: number;
  /** Average settlement time in seconds */
  readonly settlementTimeSec?: number;
  /** Protocol-specific metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Registry of protocol capabilities.
 * Used by the protocol selection layer to pick the best handler.
 */
export class ProtocolRegistry {
  private readonly registry = new Map<ProtocolName, ProtocolCapabilities>();

  /**
   * Register capabilities for a protocol.
   */
  register(capabilities: ProtocolCapabilities): void {
    this.registry.set(capabilities.protocol, capabilities);
  }

  /**
   * Get capabilities for a specific protocol.
   */
  get(protocol: ProtocolName): ProtocolCapabilities | undefined {
    return this.registry.get(protocol);
  }

  /**
   * Find all protocols that support ALL of the required capabilities.
   */
  findByCapabilities(
    required: ProtocolCapability[],
  ): ProtocolCapabilities[] {
    const results: ProtocolCapabilities[] = [];
    for (const caps of this.registry.values()) {
      if (required.every((r) => caps.capabilities.has(r))) {
        results.push(caps);
      }
    }
    return results;
  }

  /**
   * Find all protocols that support a specific chain.
   */
  findByChain(chainId: number): ProtocolCapabilities[] {
    const results: ProtocolCapabilities[] = [];
    for (const caps of this.registry.values()) {
      if (caps.chains.some((c) => c.chainId === chainId)) {
        results.push(caps);
      }
    }
    return results;
  }

  /**
   * Find the best protocol for a given set of requirements.
   * Returns protocols sorted by match quality (most capabilities matched first).
   */
  findBest(requirements: {
    capabilities?: ProtocolCapability[];
    chainId?: number;
    token?: string;
    amountUSD?: number;
  }): ProtocolCapabilities[] {
    let candidates = Array.from(this.registry.values());

    // Filter by chain
    if (requirements.chainId !== undefined) {
      candidates = candidates.filter((c) =>
        c.chains.some((ch) => ch.chainId === requirements.chainId),
      );
    }

    // Filter by token
    if (requirements.token) {
      candidates = candidates.filter(
        (c) => c.tokens.length === 0 || c.tokens.includes(requirements.token!),
      );
    }

    // Filter by amount bounds
    if (requirements.amountUSD !== undefined) {
      candidates = candidates.filter((c) => {
        if (c.minAmountUSD !== undefined && requirements.amountUSD! < c.minAmountUSD) return false;
        if (c.maxAmountUSD !== undefined && requirements.amountUSD! > c.maxAmountUSD) return false;
        return true;
      });
    }

    // Filter by required capabilities
    if (requirements.capabilities?.length) {
      candidates = candidates.filter((c) =>
        requirements.capabilities!.every((r) => c.capabilities.has(r)),
      );
    }

    // Sort by number of total capabilities (more capable = better)
    candidates.sort((a, b) => b.capabilities.size - a.capabilities.size);

    return candidates;
  }

  /**
   * List all registered protocols.
   */
  listAll(): ProtocolCapabilities[] {
    return Array.from(this.registry.values());
  }

  /**
   * Check if a protocol supports a capability.
   */
  supports(protocol: ProtocolName, capability: ProtocolCapability): boolean {
    const caps = this.registry.get(protocol);
    return caps?.capabilities.has(capability) ?? false;
  }
}
