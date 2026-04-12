/**
 * @packageDocumentation
 * @module identity/ReputationClient
 * @description
 * Client for the ERC-8004 Reputation Registry (ReputationRegistryUpgradeable).
 * 
 * Chain-agnostic for any EVM chain where ERC-8004 singletons are deployed.
 * 
 * Covers:
 * - Feedback submission (giveFeedback with optional evidence URI)
 * - Feedback revocation
 * - Response appending (agent responds to feedback)
 * - Summary queries (with trusted reviewer filtering)
 * - Individual feedback reads
 * - Reputation scoring helper
 * 
 * References:
 * - ADR-0029 §Phase 2 ReputationClient
 * - ERC8004_IMPLEMENTATION_PLAN.md Phase 2
 */
import { ethers } from 'ethers';
import {
  REPUTATION_REGISTRY_ABI,
  getERC8004Addresses,
} from './constants';
import type {
  FeedbackEntry,
  FeedbackSummary,
  FeedbackOptions,
  ERC8004Config,
} from './types';

// ============================================================================
// ReputationClient
// ============================================================================

export class ReputationClient {
  private provider: ethers.Provider;
  private signer?: ethers.Signer;
  private registryAddress: string;

  constructor(
    provider: ethers.Provider,
    signer?: ethers.Signer,
    config?: Partial<ERC8004Config>,
  ) {
    this.provider = provider;
    this.signer = signer;

    const addresses = getERC8004Addresses(config?.testnet ?? false);
    this.registryAddress = addresses.reputationRegistry;
  }

  // ==========================================================================
  // Write — Feedback Submission
  // ==========================================================================

  /**
   * Submit feedback for an agent.
   * 
   * Two overloads:
   * - Simple: value + tags only
   * - Extended: value + tags + endpointURI + feedbackURI + feedbackHash
   */
  async giveFeedback(agentId: bigint, options: FeedbackOptions): Promise<ethers.TransactionResponse> {
    this.requireSigner();
    const contract = this.getWriteContract();

    const decimals = options.valueDecimals ?? 2;
    const scaledValue = Math.round(options.value * (10 ** decimals));

    if (options.feedbackURI || options.endpointURI) {
      // Extended overload with evidence
      return contract['giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)'](
        agentId,
        scaledValue,
        decimals,
        options.tag1 || '',
        options.tag2 || '',
        options.endpointURI || '',
        options.feedbackURI || '',
        options.feedbackHash || ethers.ZeroHash,
      );
    }

    // Simple overload
    return contract['giveFeedback(uint256,int128,uint8,string,string)'](
      agentId,
      scaledValue,
      decimals,
      options.tag1 || '',
      options.tag2 || '',
    );
  }

  /**
   * Revoke previously submitted feedback.
   */
  async revokeFeedback(agentId: bigint, feedbackIndex: bigint): Promise<ethers.TransactionResponse> {
    this.requireSigner();
    const contract = this.getWriteContract();
    return contract.revokeFeedback(agentId, feedbackIndex);
  }

  /**
   * Append a response to feedback (agent responds to a reviewer's feedback).
   */
  async appendResponse(
    agentId: bigint,
    clientAddress: string,
    feedbackIndex: bigint,
    responseURI: string,
    responseHash: string,
  ): Promise<ethers.TransactionResponse> {
    this.requireSigner();
    const contract = this.getWriteContract();
    return contract.appendResponse(agentId, clientAddress, feedbackIndex, responseURI, responseHash);
  }

  // ==========================================================================
  // Read — Summaries
  // ==========================================================================

  /**
   * Get aggregated feedback summary for an agent.
   * 
   * @param agentId - The agent to query
   * @param clientAddresses - Filter by specific reviewers (empty = all)
   * @param tag1 - Filter by primary tag
   * @param tag2 - Filter by secondary tag
   */
  async getSummary(
    agentId: bigint,
    clientAddresses: string[] = [],
    tag1 = '',
    tag2 = '',
  ): Promise<FeedbackSummary> {
    const contract = this.getReadContract();

    try {
      const [count, summaryValue, summaryValueDecimals] = await contract.getSummary(
        agentId, clientAddresses, tag1, tag2,
      );
      return { count, summaryValue, summaryValueDecimals };
    } catch {
      return { count: 0n, summaryValue: 0n, summaryValueDecimals: 0 };
    }
  }

  /**
   * Get a normalized reputation score (0-100) for an agent.
   * Convenience wrapper around getSummary().
   */
  async getReputationScore(
    agentId: bigint,
    trustedReviewers?: string[],
  ): Promise<number> {
    const summary = await this.getSummary(agentId, trustedReviewers || []);
    if (summary.count === 0n) return 0;

    return summary.summaryValueDecimals > 0
      ? Number(summary.summaryValue) / (10 ** summary.summaryValueDecimals)
      : Number(summary.summaryValue);
  }

  // ==========================================================================
  // Read — Individual Feedback
  // ==========================================================================

  /**
   * Read a specific feedback entry.
   */
  async readFeedback(
    agentId: bigint,
    clientAddress: string,
    feedbackIndex: bigint,
  ): Promise<FeedbackEntry> {
    const contract = this.getReadContract();

    const [value, valueDecimals, tag1, tag2, isRevoked] = await contract.readFeedback(
      agentId, clientAddress, feedbackIndex,
    );

    return { value, valueDecimals, tag1, tag2, isRevoked };
  }

  /**
   * Read all feedback entries for an agent from specific clients.
   */
  async readAllFeedback(
    agentId: bigint,
    clientAddresses: string[],
    options?: { tag1?: string; tag2?: string; includeRevoked?: boolean },
  ): Promise<FeedbackEntry[]> {
    const entries: FeedbackEntry[] = [];

    for (const client of clientAddresses) {
      try {
        const lastIndex = await this.getLastIndex(agentId, client);
        for (let i = 0n; i <= lastIndex; i++) {
          try {
            const entry = await this.readFeedback(agentId, client, i);

            // Filter by tags if specified
            if (options?.tag1 && entry.tag1 !== options.tag1) continue;
            if (options?.tag2 && entry.tag2 !== options.tag2) continue;
            if (!options?.includeRevoked && entry.isRevoked) continue;

            entries.push(entry);
          } catch {
            break; // No more entries for this client
          }
        }
      } catch {
        continue; // Client has no feedback
      }
    }

    return entries;
  }

  /**
   * Get all client addresses that have given feedback to an agent.
   */
  async getClients(agentId: bigint): Promise<string[]> {
    const contract = this.getReadContract();
    try {
      return await contract.getClients(agentId);
    } catch {
      return [];
    }
  }

  /**
   * Get the last feedback index for a specific client → agent pair.
   */
  async getLastIndex(agentId: bigint, clientAddress: string): Promise<bigint> {
    const contract = this.getReadContract();
    try {
      return await contract.getLastIndex(agentId, clientAddress);
    } catch {
      return 0n;
    }
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getRegistryAddress(): string {
    return this.registryAddress;
  }

  getProvider(): ethers.Provider {
    return this.provider;
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  private getReadContract(): ethers.Contract {
    return new ethers.Contract(this.registryAddress, REPUTATION_REGISTRY_ABI, this.provider);
  }

  private getWriteContract(): ethers.Contract {
    return new ethers.Contract(this.registryAddress, REPUTATION_REGISTRY_ABI, this.signer);
  }

  private requireSigner(): void {
    if (!this.signer) {
      throw new Error('ReputationClient: signer required for write operations.');
    }
  }
}
