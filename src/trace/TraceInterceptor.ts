/**
 * @packageDocumentation
 * @module TraceInterceptor
 * @description
 * Captures the full LLM reasoning chain for every agent decision,
 * produces a deterministic keccak256 hash, and signs it with the session key.
 *
 * Promoted from the enterprise demo's TraceInterceptor with enhancements:
 * - Framework-agnostic (works with any LLM provider)
 * - Canonical JSON for deterministic hashing (sorted keys)
 * - Session key signing for cryptographic binding
 * - Storage adapter integration
 */

import { ethers } from 'ethers';
import type {
  VeridexTracePayload,
  TraceResult,
  ToolCallRecord,
  ReasoningContext,
  TraceStorageAdapter,
  StorageReceipt,
} from './types';
import type { ProposedAction, VerdictResult } from '../policy/types';

// ── Implementation ──

export class TraceInterceptor {
  private storageAdapter?: TraceStorageAdapter;

  constructor(storageAdapter?: TraceStorageAdapter) {
    this.storageAdapter = storageAdapter;
  }

  /**
   * Capture a trace from an agent decision.
   * This wraps the decision function, recording the full reasoning chain.
   */
  async capture(params: {
    sessionKeyHash: string;
    agentId?: string;
    reasoning: ReasoningContext;
    proposedAction: ProposedAction;
    policyEvaluation?: VerdictResult;
    environment?: Record<string, unknown>;
  }): Promise<TraceResult> {
    const traceId = this.generateTraceId();

    const trace: VeridexTracePayload = {
      traceId,
      timestamp: Date.now(),
      agentId: params.agentId,
      sessionKeyHash: params.sessionKeyHash,
      reasoning: params.reasoning,
      proposedAction: params.proposedAction,
      policyEvaluation: params.policyEvaluation,
      environment: params.environment,
    };

    const traceHash = this.hash(trace);

    return { trace, traceHash };
  }

  /**
   * Wrap an agent decision function with trace capture.
   * The decision function receives context and returns the action + reasoning.
   */
  async intercept<T extends ProposedAction>(
    sessionKeyHash: string,
    decisionFn: () => Promise<{
      action: T;
      reasoning: ReasoningContext;
    }>,
    options?: {
      agentId?: string;
      policyEvaluation?: VerdictResult;
      environment?: Record<string, unknown>;
    }
  ): Promise<TraceResult & { action: T }> {
    const decision = await decisionFn();

    const result = await this.capture({
      sessionKeyHash,
      agentId: options?.agentId,
      reasoning: decision.reasoning,
      proposedAction: decision.action,
      policyEvaluation: options?.policyEvaluation,
      environment: options?.environment,
    });

    return { ...result, action: decision.action };
  }

  /**
   * Deterministic keccak256 hash of the trace.
   * Uses canonical JSON (sorted keys, deterministic serialization)
   * for reproducibility across different environments.
   */
  hash(trace: VeridexTracePayload): `0x${string}` {
    const canonical = this.canonicalize(trace);
    return ethers.keccak256(ethers.toUtf8Bytes(canonical)) as `0x${string}`;
  }

  /**
   * Sign the trace hash with an ethers signer (session key wallet).
   */
  async sign(
    traceHash: `0x${string}`,
    signer: ethers.Signer
  ): Promise<string> {
    return signer.signMessage(ethers.getBytes(traceHash));
  }

  /**
   * Store a trace to the configured storage adapter.
   */
  async store(
    trace: VeridexTracePayload,
    traceHash: string
  ): Promise<StorageReceipt | null> {
    if (!this.storageAdapter) return null;
    return this.storageAdapter.store(trace, traceHash);
  }

  /**
   * Retrieve a stored trace by content ID.
   */
  async retrieve(contentId: string): Promise<VeridexTracePayload | null> {
    if (!this.storageAdapter) return null;
    return this.storageAdapter.retrieve(contentId);
  }

  /**
   * Verify that a trace hash matches the stored content.
   */
  async verify(contentId: string, expectedHash: string): Promise<boolean> {
    if (!this.storageAdapter) return false;
    return this.storageAdapter.verify(contentId, expectedHash);
  }

  /**
   * Verify a trace hash independently (without storage).
   * Given a trace payload, recompute the hash and compare.
   */
  verifyTrace(trace: VeridexTracePayload, expectedHash: `0x${string}`): boolean {
    const computed = this.hash(trace);
    return computed === expectedHash;
  }

  /**
   * Verify a signature over a trace hash.
   */
  verifySignature(
    traceHash: `0x${string}`,
    signature: string,
    expectedAddress: string
  ): boolean {
    const recovered = ethers.verifyMessage(ethers.getBytes(traceHash), signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  }

  /** Set or update the storage adapter. */
  setStorageAdapter(adapter: TraceStorageAdapter): void {
    this.storageAdapter = adapter;
  }

  /**
   * Canonical JSON serialization with sorted keys.
   * Ensures deterministic output across environments.
   */
  private canonicalize(obj: unknown): string {
    return JSON.stringify(obj, (_, value) => {
      // Sort object keys
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value)
          .sort()
          .reduce<Record<string, unknown>>((sorted, key) => {
            sorted[key] = (value as Record<string, unknown>)[key];
            return sorted;
          }, {});
      }
      // Convert bigint to string for JSON serialization
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    });
  }

  /** Generate a unique trace ID. */
  private generateTraceId(): string {
    // Use crypto.randomUUID if available, fallback to timestamp + random
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
