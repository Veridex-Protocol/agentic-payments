/**
 * @packageDocumentation
 * @module identity/TrustGate
 * @description
 * Pre-payment reputation check for agent.fetch().
 * 
 * Before paying a merchant via x402/UCP/ACP/AP2, the TrustGate:
 * 1. Resolves the merchant's ERC-8004 agentId from their endpoint domain
 * 2. Queries the Reputation Registry for their score
 * 3. Applies the configured trust threshold
 * 4. Returns trusted/untrusted with reason
 * 
 * This creates a virtuous cycle: agents pay → submit feedback → future agents
 * use feedback to decide who to pay.
 * 
 * References:
 * - ADR-0029 §Trust-Gated Fetch
 * - ERC8004_IMPLEMENTATION_PLAN.md Phase 2 TrustGate
 */
import { ReputationClient } from './ReputationClient';
import { IdentityClient } from './IdentityClient';
import type {
  TrustGateConfig,
  TrustCheckResult,
  AgentRegistration,
} from './types';

// ============================================================================
// TrustGate
// ============================================================================

export class TrustGate {
  private reputationClient: ReputationClient;
  private identityClient: IdentityClient;
  private config: TrustGateConfig;

  constructor(
    reputationClient: ReputationClient,
    identityClient: IdentityClient,
    config: TrustGateConfig,
  ) {
    this.reputationClient = reputationClient;
    this.identityClient = identityClient;
    this.config = config;
  }

  /**
   * Check if a merchant endpoint is trusted before making a payment.
   * 
   * @param endpoint - The merchant's service endpoint URL
   * @returns Trust check result with score and reason
   */
  async checkMerchantTrust(endpoint: string): Promise<TrustCheckResult> {
    // Step 1: Resolve merchant agent identity from endpoint
    const agent = await this.resolveMerchantAgent(endpoint);

    if (!agent) {
      // No ERC-8004 identity found
      if (this.config.minReputation > 0) {
        return {
          trusted: false,
          score: 0,
          reason: 'Merchant has no ERC-8004 identity registered',
        };
      }
      return { trusted: true, score: 0, reason: 'No identity required (minReputation=0)' };
    }

    // Step 2: Query reputation
    const score = await this.reputationClient.getReputationScore(
      agent.agentId,
      this.config.trustedReviewers,
    );

    // Step 3: Apply threshold
    const trusted = score >= this.config.minReputation;

    return {
      trusted,
      score,
      agentId: agent.agentId,
      reason: trusted
        ? `Score ${score} meets threshold ${this.config.minReputation}`
        : `Score ${score} below threshold ${this.config.minReputation}`,
    };
  }

  /**
   * Resolve a merchant's ERC-8004 agent identity from their endpoint URL.
   * 
   * Resolution order:
   * 1. Check /.well-known/agent-registration.json
   * 2. (Future) Query Relayer index
   */
  async resolveMerchantAgent(endpoint: string): Promise<AgentRegistration | null> {
    return this.identityClient.resolveAgentFromEndpoint(endpoint);
  }

  /**
   * Get the current trust configuration.
   */
  getConfig(): TrustGateConfig {
    return { ...this.config };
  }

  /**
   * Update the trust configuration.
   */
  updateConfig(config: Partial<TrustGateConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
