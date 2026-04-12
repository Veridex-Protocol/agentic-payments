/**
 * @packageDocumentation
 * @module TraceTypes
 * @description
 * Type definitions for the Trace & Evidence Layer.
 * Every agent decision produces a cryptographically verifiable trace
 * that binds the LLM reasoning chain to on-chain transaction data.
 */

import type { ProposedAction, VerdictResult } from '../policy/types';

// ── Trace Payload ──

/** Record of a tool/function call made by the agent. */
export interface ToolCallRecord {
  /** Tool/function name */
  tool: string;
  /** Arguments passed to the tool */
  inputs: Record<string, unknown>;
  /** Results returned by the tool */
  outputs: Record<string, unknown>;
  /** When the call was made */
  timestamp: number;
}

/** The reasoning context captured from the agent's decision process. */
export interface ReasoningContext {
  /** The prompt/instructions the agent received */
  prompt?: string;
  /** Tool calls made during reasoning */
  toolCalls: ToolCallRecord[];
  /** The raw LLM output/reasoning */
  llmOutput?: string;
}

/**
 * Complete trace payload — the full record of an agent's decision.
 * This is the data that gets hashed, signed, and stored.
 */
export interface VeridexTracePayload {
  /** Unique trace identifier */
  traceId: string;
  /** Timestamp of the trace capture */
  timestamp: number;
  /** Agent identifier (ERC-8004 agentId or custom identifier) */
  agentId?: string;
  /** Hash of the session key used to sign */
  sessionKeyHash: string;
  /** The agent's reasoning context */
  reasoning: ReasoningContext;
  /** The action the agent proposed */
  proposedAction: ProposedAction;
  /** Policy evaluation result (if policy engine was active) */
  policyEvaluation?: VerdictResult;
  /** Environment metadata */
  environment?: Record<string, unknown>;
}

// ── Trace Result ──

/** Result of trace capture including hash and signature. */
export interface TraceResult {
  /** The full trace payload */
  trace: VeridexTracePayload;
  /** Deterministic keccak256 hash of the trace */
  traceHash: `0x${string}`;
  /** Session key signature of the trace hash */
  signature?: string;
}

// ── Evidence & Dispute ──

/** Settlement proof from on-chain verification. */
export interface SettlementProof {
  /** Transaction hash */
  txHash: string;
  /** Block number where settlement was confirmed */
  blockNumber?: number;
  /** Whether the traceHash was found in the transaction calldata */
  traceHashInCalldata: boolean;
  /** Chain the settlement was on */
  chain: number;
  /** Block explorer URL */
  explorerUrl?: string;
}

/** Storage receipt from decentralized storage. */
export interface StorageReceipt {
  /** Storage provider (filecoin, arweave, ipfs, memory) */
  provider: string;
  /** Content identifier (CID, hash, or key) */
  contentId: string;
  /** When the trace was stored */
  storedAt: number;
  /** Whether the storage is immutable */
  immutable: boolean;
}

/**
 * A complete evidence bundle for dispute resolution.
 * Contains everything needed to independently verify an agent's action.
 */
export interface DisputeBundle {
  /** The trace payload */
  trace: VeridexTracePayload;
  /** Deterministic hash of the trace */
  traceHash: `0x${string}`;
  /** Signature over the trace hash */
  signature: string;
  /** Policy evaluation verdict */
  verdict: VerdictResult;
  /** On-chain settlement proof (if applicable) */
  settlementProof?: SettlementProof;
  /** Decentralized storage receipt */
  storageReceipt?: StorageReceipt;
  /** Hash of the entire bundle (for tamper detection) */
  bundleHash: `0x${string}`;
  /** When the bundle was assembled */
  assembledAt: number;
}

// ── Storage Adapter ──

/** Interface for trace storage backends. */
export interface TraceStorageAdapter {
  /** Store a trace payload. Returns a storage receipt. */
  store(trace: VeridexTracePayload, traceHash: string): Promise<StorageReceipt>;
  /** Retrieve a stored trace by content ID. */
  retrieve(contentId: string): Promise<VeridexTracePayload | null>;
  /** Verify that a stored trace matches the expected hash. */
  verify(contentId: string, expectedHash: string): Promise<boolean>;
}
