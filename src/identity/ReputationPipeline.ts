/**
 * @packageDocumentation
 * @module ReputationPipeline
 * @description
 * Automatically submits reputation feedback to ERC-8004 after x402 payment settlements.
 * 
 * Integrates with AgentWallet.fetch() via the onAfterPayment callback to:
 * 1. Measure latency of the service call
 * 2. Determine success/failure
 * 3. Calculate a reputation score (0-100)
 * 4. Submit feedback to the on-chain Reputation Registry
 * 
 * This closes the trust loop: hire agent → pay → rate → reputation grows.
 */
import { ERC8004Client, type FeedbackParams } from './ERC8004Client';

// ============================================================================
// Types
// ============================================================================

export interface SettlementEvent {
  success: boolean;
  protocol: string;
  network: string;
  amount: string;
  token: string;
  settledAt: number;
}

export interface ServiceCallMetrics {
  agentId: bigint;
  latencyMs: number;
  statusCode: number;
  success: boolean;
  amountPaid: string;
  token: string;
  protocol: string;
  timestamp: number;
}

export interface ReputationPipelineConfig {
  /** ERC8004Client instance for submitting feedback */
  erc8004Client: ERC8004Client;
  /** Whether to auto-submit feedback (default: true) */
  autoSubmit?: boolean;
  /** Minimum score threshold to submit (default: 0, submit all) */
  minScoreToSubmit?: number;
  /** Tag for feedback categorization */
  feedbackTag?: string;
}

// ============================================================================
// ReputationPipeline
// ============================================================================

export class ReputationPipeline {
  private erc8004: ERC8004Client;
  private autoSubmit: boolean;
  private minScoreToSubmit: number;
  private feedbackTag: string;
  private pendingFeedback: ServiceCallMetrics[] = [];

  constructor(config: ReputationPipelineConfig) {
    this.erc8004 = config.erc8004Client;
    this.autoSubmit = config.autoSubmit ?? true;
    this.minScoreToSubmit = config.minScoreToSubmit ?? 0;
    this.feedbackTag = config.feedbackTag ?? 'x402';
  }

  /**
   * Record a service call and optionally auto-submit feedback.
   * Call this after a successful agent.fetch() with payment.
   */
  async recordServiceCall(metrics: ServiceCallMetrics): Promise<void> {
    this.pendingFeedback.push(metrics);

    if (this.autoSubmit) {
      await this.submitFeedback(metrics);
    }
  }

  /**
   * Submit reputation feedback for a service call.
   */
  async submitFeedback(metrics: ServiceCallMetrics): Promise<void> {
    const score = this.calculateScore(metrics);

    if (score < this.minScoreToSubmit) {
      return;
    }

    const params: FeedbackParams = {
      agentId: metrics.agentId,
      value: score,
      valueDecimals: 2,
      tag1: this.feedbackTag,
      tag2: metrics.protocol,
    };

    try {
      await this.erc8004.giveFeedback(params);
      console.log(
        `[ReputationPipeline] Feedback submitted for agent #${metrics.agentId}: ` +
        `score=${score}, latency=${metrics.latencyMs}ms, success=${metrics.success}`
      );
    } catch (error: any) {
      // Non-blocking: testnet registries may not accept feedback
      console.warn(
        `[ReputationPipeline] Feedback submission failed (non-blocking): ${error.message}`
      );
    }
  }

  /**
   * Flush all pending feedback (for batch submission).
   */
  async flushPending(): Promise<void> {
    const pending = [...this.pendingFeedback];
    this.pendingFeedback = [];

    for (const metrics of pending) {
      await this.submitFeedback(metrics);
    }
  }

  /**
   * Get pending feedback count.
   */
  getPendingCount(): number {
    return this.pendingFeedback.length;
  }

  /**
   * Calculate a reputation score (0-100) from service call metrics.
   * 
   * Scoring formula:
   * - Base: 50 (neutral)
   * - Success: +30
   * - Failure: -40
   * - Latency bonus: +20 if < 100ms, +10 if < 500ms, 0 if < 2s, -10 if > 2s
   * - Capped to [0, 100]
   */
  calculateScore(metrics: ServiceCallMetrics): number {
    let score = 50;

    // Success/failure
    if (metrics.success) {
      score += 30;
    } else {
      score -= 40;
    }

    // Latency
    if (metrics.latencyMs < 100) {
      score += 20;
    } else if (metrics.latencyMs < 500) {
      score += 10;
    } else if (metrics.latencyMs < 2000) {
      // neutral
    } else {
      score -= 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Create an onAfterPayment callback for AgentWallet.fetch().
   * 
   * Usage:
   * ```typescript
   * const pipeline = new ReputationPipeline({ erc8004Client });
   * const response = await agent.fetch(url, {
   *   onAfterPayment: pipeline.createCallback(targetAgentId, startTime),
   * });
   * ```
   */
  createCallback(agentId: bigint, startTime: number) {
    return async (settlement: SettlementEvent) => {
      await this.recordServiceCall({
        agentId,
        latencyMs: Date.now() - startTime,
        statusCode: settlement.success ? 200 : 500,
        success: settlement.success,
        amountPaid: settlement.amount,
        token: settlement.token,
        protocol: settlement.protocol,
        timestamp: Date.now(),
      });
    };
  }
}
