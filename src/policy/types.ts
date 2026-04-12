/**
 * @packageDocumentation
 * @module PolicyTypes
 * @description
 * Core type definitions for the Agent-Safe Execution Control Plane.
 *
 * Every agent action flows through the policy engine before execution.
 * The `Verdict` determines whether the action proceeds, gets flagged,
 * requires human escalation, or is blocked outright.
 *
 * The `Mandate` is the versioned configuration that defines what an agent
 * is allowed to do — assets, chains, counterparties, spending limits,
 * time windows, and escalation thresholds.
 */

import type { StoredSession } from '../session/SessionStorage';
import type { ProtocolName } from '../protocols/base/types';

// ── Verdict System ──

/** The four possible outcomes of policy evaluation. */
export type Verdict = 'pass' | 'flag' | 'escalate' | 'block';

/** Individual check result from a single policy rule. */
export interface PolicyCheck {
  /** Rule identifier */
  ruleId: string;
  /** Human-readable rule name */
  ruleName: string;
  /** Whether the check passed */
  passed: boolean;
  /** The verdict this rule produced */
  verdict: Verdict;
  /** Explanation of the check result */
  reason: string;
  /** Risk contribution (0–100) */
  riskContribution: number;
  /** Additional context from the rule evaluation */
  metadata?: Record<string, unknown>;
}

/** Aggregate result of all policy rules evaluated against a proposed action. */
export interface VerdictResult {
  /** Final verdict (worst across all checks) */
  verdict: Verdict;
  /** Aggregate risk score (0–100) */
  riskScore: number;
  /** Human-readable reasons for the verdict */
  reasons: string[];
  /** Individual check details */
  checks: PolicyCheck[];
  /** Mandate version used for this evaluation */
  mandateVersion: string;
  /** Timestamp of evaluation */
  evaluatedAt: number;
  /** If escalation required, the rule that triggered it */
  escalationTrigger?: string;
  /** Cryptographic attestation of the verdict (optional, for on-chain binding) */
  attestation?: string;
}

// ── Policy Rules ──

/** Severity levels for policy rules (evaluation order: critical first). */
export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low';

/** Interface that all policy rules must implement. */
export interface PolicyRule {
  /** Unique rule identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Rule severity — determines evaluation order */
  readonly severity: RuleSeverity;
  /** Whether the rule is active */
  enabled: boolean;
  /** Evaluate the rule against a proposed action context */
  evaluate(ctx: EvaluationContext): Promise<PolicyCheck>;
}

// ── Proposed Action ──

/** Action types that the policy engine can evaluate. */
export type ActionType = 'payment' | 'swap' | 'bridge' | 'transfer' | 'approval' | 'custom';

/** A normalized representation of what the agent wants to do. */
export interface ProposedAction {
  /** Type of action */
  type: ActionType;
  /** Recipient address or endpoint */
  recipient: string;
  /** Token/asset identifier */
  asset: string;
  /** Amount in token's smallest unit */
  amount: string;
  /** Estimated USD value */
  amountUSD: number;
  /** Target chain (Wormhole chain ID) */
  chain: number;
  /** Protocol being used */
  protocol: ProtocolName;
  /** Additional action-specific data */
  metadata?: Record<string, unknown>;
}

// ── Evaluation Context ──

/** Full context provided to policy rules during evaluation. */
export interface EvaluationContext {
  /** The proposed action to evaluate */
  action: ProposedAction;
  /** Active session information */
  session: StoredSession;
  /** The active mandate (populated by PolicyEngine before rule evaluation) */
  mandate: Mandate;
  /** Trace data from the LLM reasoning chain (if available) */
  trace?: TraceContext;
  /** Agent identity information (ERC-8004, if available) */
  agentIdentity?: AgentIdentityContext;
  /** Recent transaction history for pattern analysis */
  history?: TransactionHistoryEntry[];
  /** Timestamp of this evaluation */
  timestamp: number;
}

/** Trace context from the LLM reasoning chain. */
export interface TraceContext {
  traceId: string;
  prompt?: string;
  toolCalls?: Array<{
    tool: string;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    timestamp: number;
  }>;
  llmOutput?: string;
}

/** Agent identity context for trust-based policy decisions. */
export interface AgentIdentityContext {
  agentId: bigint;
  reputationScore: number;
  registeredAt: number;
  operator: string;
}

/** Historical transaction record for pattern analysis. */
export interface TransactionHistoryEntry {
  timestamp: number;
  recipient: string;
  asset: string;
  amountUSD: number;
  chain: number;
  protocol: ProtocolName;
  verdict: Verdict;
}

// ── Mandate ──

/** Spending limit configuration at multiple time horizons. */
export interface LimitConfig {
  /** Maximum USD per single transaction */
  perTransaction: number;
  /** Maximum USD per rolling 24-hour window */
  daily: number;
  /** Maximum USD per rolling 7-day window (optional) */
  weekly?: number;
  /** Maximum USD per rolling 30-day window (optional) */
  monthly?: number;
  /** Maximum USD lifetime (optional) */
  lifetime?: number;
  /** Per-token overrides (token symbol → limit config subset) */
  tokenOverrides?: Record<string, Partial<Omit<LimitConfig, 'tokenOverrides'>>>;
}

/** Time window constraint for when actions are allowed. */
export interface TimeWindow {
  /** Days of week (0=Sunday, 6=Saturday). Empty = all days. */
  allowedDays: number[];
  /** Start hour (0–23, UTC). Omit for no start constraint. */
  startHourUTC?: number;
  /** End hour (0–23, UTC). Omit for no end constraint. */
  endHourUTC?: number;
  /** Timezone identifier for display purposes */
  timezone?: string;
}

/** Configuration for when the circuit breaker should trip. */
export interface CircuitBreakerConfig {
  /** Number of consecutive blocks before tripping */
  consecutiveBlocksToTrip: number;
  /** Number of blocks in the half-open state before re-opening */
  halfOpenMaxAttempts: number;
  /** Cooldown period in ms before transitioning to half-open */
  cooldownMs: number;
  /** Auto-trip on injection detection */
  tripOnInjection: boolean;
  /** Auto-trip on anomaly detection */
  tripOnAnomaly: boolean;
}

/** Configuration for when to require human escalation. */
export interface EscalationThreshold {
  /** Minimum risk score to trigger escalation */
  riskScoreThreshold: number;
  /** Minimum USD amount to require human approval */
  amountUSDThreshold: number;
  /** Timeout in ms before auto-rejecting escalated actions */
  timeoutMs: number;
  /** Channels to notify on escalation */
  notifyChannels?: string[];
}

/**
 * The Mandate — a versioned, comprehensive policy document that defines
 * what an agent is authorized to do. This is the off-chain equivalent
 * of the on-chain Guard (ADR-0035).
 */
export interface Mandate {
  /** Unique mandate identifier */
  id: string;
  /** Semantic version of the mandate */
  version: string;
  /** Human-readable name */
  name: string;
  /** When this mandate was created */
  createdAt: number;
  /** When this mandate was last updated */
  updatedAt: number;
  /** Who issued the mandate (operator address or identifier) */
  issuer: string;

  // ── Whitelists ──

  /** Allowed token symbols or addresses. Empty = all allowed. */
  allowedAssets: string[];
  /** Allowed chain IDs (Wormhole chain IDs). Empty = all allowed. */
  allowedChains: number[];
  /** Allowed counterparty addresses. Empty = all allowed. */
  allowedCounterparties: string[];
  /** Allowed protocols. Empty = all allowed. */
  allowedProtocols: ProtocolName[];

  // ── Limits ──

  /** Spending limits at multiple time horizons */
  limits: LimitConfig;

  // ── Time Constraints ──

  /** Time windows when actions are allowed. Empty = always allowed. */
  timeWindows: TimeWindow[];

  // ── Safety ──

  /** Escalation configuration */
  escalation: EscalationThreshold;
  /** Circuit breaker configuration */
  circuitBreaker: CircuitBreakerConfig;

  /** Custom rules (loaded dynamically) */
  customRules?: PolicyRule[];
}
