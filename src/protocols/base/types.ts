/**
 * @packageDocumentation
 * @module ProtocolTypes
 * @description
 * Shared type definitions for the Universal Protocol Abstraction Layer.
 * All protocol handlers share these common types for detection, cost estimation,
 * and settlement.
 */

import { ethers } from 'ethers';
import { StoredSession } from '../../session/SessionStorage';

/** Supported protocol identifiers */
export type ProtocolName = 'x402' | 'ucp' | 'acp' | 'ap2' | 'axtp' | 'direct' | 'mpp';

/** Cost estimate returned before committing to a payment */
export interface CostEstimate {
  /** Estimated cost in USD */
  amountUSD: number;
  /** Raw amount in token's smallest unit */
  amountRaw: string;
  /** Token symbol or address */
  token: string;
  /** Chain identifier (Wormhole chain ID or network string) */
  chain: number | string;
  /** Payment scheme (exact, upto, subscription, etc.) */
  scheme: string;
  /** Confidence level of the estimate (0-1) */
  confidence: number;
  /** Human-readable description */
  description?: string;
}

/** Result of protocol detection */
export interface DetectionResult {
  /** The protocol that was detected */
  protocol: ProtocolName;
  /** Confidence score (0-1) */
  confidence: number;
  /** Detection metadata (headers found, URLs discovered, etc.) */
  metadata: Record<string, unknown>;
}

/** Options for the universal fetch wrapper */
export interface UniversalFetchOptions extends RequestInit {
  /** Force a specific protocol (skip auto-detection) */
  protocol?: ProtocolName;
  /** Allowed protocols (whitelist) */
  allowedProtocols?: ProtocolName[];
  /** Maximum USD amount to auto-approve */
  maxAutoApproveUSD?: number;
  /** Whether to skip cost estimation */
  skipEstimate?: boolean;
  /** Custom timeout for this request (ms) */
  timeoutMs?: number;
  /** Callback before payment is executed */
  onBeforePayment?: (estimate: CostEstimate) => Promise<boolean>;
  /** Callback after payment is settled */
  onAfterPayment?: (receipt: PaymentSettlement) => void;
  /** Callback on protocol detection */
  onProtocolDetected?: (result: DetectionResult) => void;
}

/** Settlement receipt from any protocol */
export interface PaymentSettlement {
  /** Whether the payment succeeded */
  success: boolean;
  /** Protocol used */
  protocol: ProtocolName;
  /** Transaction hash (if on-chain) */
  txHash?: string;
  /** Network/chain where settled */
  network: string;
  /** Amount settled (human-readable) */
  amount: string;
  /** Token used */
  token: string;
  /** USD value */
  amountUSD?: number;
  /** Timestamp */
  settledAt: number;
  /** Error message if failed */
  error?: string;
  /** Protocol-specific metadata */
  metadata?: Record<string, unknown>;
  /** Whether ERC-8004 reputation feedback was submitted after this payment (ADR-0029) */
  feedbackSubmitted?: boolean;
  /** The merchant's ERC-8004 agentId that received feedback */
  merchantAgentId?: bigint;
}

/** Protocol handler context passed to each handler */
export interface ProtocolContext {
  /** Active session for authorization */
  session: StoredSession;
  /** Pre-decrypted signing wallet — handlers MUST use this instead of session.encryptedPrivateKey */
  signerWallet?: ethers.Wallet;
  /** Relayer URL for settlement */
  relayerUrl?: string;
  /** Relayer API key */
  relayerApiKey?: string;
  /** Price oracle for USD conversion */
  estimateUSD?: (token: string, amount: string, chain: number | string) => Promise<number>;
  /** ERC-8004 agent identity (ADR-0029) — set when agent is registered */
  agentIdentity?: {
    agentId: bigint;
    agentURI: string;
    registryChain: string;
  };
}

/** Cache entry for protocol detection results */
export interface DetectionCacheEntry {
  /** Detected protocol */
  protocol: ProtocolName;
  /** When this was cached */
  cachedAt: number;
  /** TTL in ms */
  ttlMs: number;
}
