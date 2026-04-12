/**
 * @packageDocumentation
 * @module Policy
 * @description
 * Policy Engine — the heart of the Agent-Safe Execution Control Plane.
 * Evaluates every proposed action against a versioned mandate before execution.
 */

// Core
export { PolicyEngine } from './PolicyEngine';
export type {
  Verdict,
  VerdictResult,
  PolicyRule,
  PolicyCheck,
  RuleSeverity,
  Mandate,
  LimitConfig,
  TimeWindow,
  CircuitBreakerConfig,
  EscalationThreshold,
  EvaluationContext,
  ProposedAction,
  ActionType,
  TraceContext,
  AgentIdentityContext,
  TransactionHistoryEntry,
} from './types';

// Built-in Rules
export { AssetWhitelistRule } from './rules/AssetWhitelistRule';
export { ChainWhitelistRule } from './rules/ChainWhitelistRule';
export { ProtocolWhitelistRule } from './rules/ProtocolWhitelistRule';
export { SpendingLimitRule } from './rules/SpendingLimitRule';
export { CounterpartyRule } from './rules/CounterpartyRule';
export { TimeWindowRule } from './rules/TimeWindowRule';
export { VelocityRule } from './rules/VelocityRule';
export type { VelocityConfig } from './rules/VelocityRule';
export { HumanApprovalRule } from './rules/HumanApprovalRule';
