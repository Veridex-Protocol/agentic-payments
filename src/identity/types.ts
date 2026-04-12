/**
 * @packageDocumentation
 * @module identity/types
 * @description
 * Type definitions for the ERC-8004 identity module.
 * 
 * Covers:
 * - On-chain types (AgentRegistration, FeedbackEntry, ValidationStatus)
 * - Registration file schema (ERC-8004 compliant)
 * - SDK config types (ERC8004Config, TrustGateConfig, DiscoveryQuery)
 * - UATL types (UAI, ChainPresence, AggregatedReputation, TrustAttestation)
 * 
 * References:
 * - ERC-8004 spec: https://eips.ethereum.org/EIPS/eip-8004
 * - ADR-0029: ERC-8004 Trustless Agent Identity and Reputation
 * - UATL paper: Universal Agent Trust Layer
 */
import type { ethers } from 'ethers';

// ============================================================================
// On-Chain Types — Identity Registry
// ============================================================================

/** Agent registration as stored on-chain in the ERC-8004 Identity Registry */
export interface AgentRegistration {
  agentId: bigint;
  owner: string;
  agentURI: string;
  agentWallet: string;
}

/** Key-value metadata entry for agent registration */
export interface MetadataEntry {
  key: string;
  value: string;
}

// ============================================================================
// On-Chain Types — Reputation Registry
// ============================================================================

/** Individual feedback entry from the Reputation Registry */
export interface FeedbackEntry {
  value: bigint;          // int128
  valueDecimals: number;  // uint8
  tag1: string;
  tag2: string;
  isRevoked: boolean;
}

/** Aggregated feedback summary from the Reputation Registry */
export interface FeedbackSummary {
  count: bigint;
  summaryValue: bigint;
  summaryValueDecimals: number;
}

// ============================================================================
// On-Chain Types — Validation Registry (Phase 3)
// ============================================================================

/** Validation status from the Validation Registry */
export interface ValidationStatus {
  validatorAddress: string;
  agentId: bigint;
  response: number;       // 0-100
  responseHash: string;
  tag: string;
  lastUpdate: bigint;
}

// ============================================================================
// Registration File Schema (ERC-8004 Compliant)
// ============================================================================

/**
 * ERC-8004 Agent Registration File.
 * Published at the agentURI (IPFS or data URI) and optionally at
 * `/.well-known/agent-registration.json` on the agent's domain.
 * 
 * Schema: https://eips.ethereum.org/EIPS/eip-8004#registration-v1
 */
export interface AgentRegistrationFile {
  type: string;                         // "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"
  name: string;
  description: string;
  image?: string;
  services: ServiceEndpoint[];
  x402Support: boolean;
  active: boolean;
  registrations: AgentRegistryRef[];
  supportedTrust?: string[];            // e.g. ["reputation", "crypto-economic"]
}

/** Service endpoint in the registration file */
export interface ServiceEndpoint {
  name: string;                         // e.g. "A2A", "MCP", "web", "x402"
  endpoint: string;                     // URL
  version?: string;
  skills?: string[];
  domains?: string[];
}

/** Cross-chain registry reference in the registration file */
export interface AgentRegistryRef {
  agentId: number;
  agentRegistry: string;                // CAIP-2 format: "eip155:{chainId}:{address}"
}

// ============================================================================
// SDK Config Types
// ============================================================================

/**
 * ERC-8004 configuration for AgentWallet.
 * Passed as `erc8004` section in AgentWalletConfig.
 */
export interface ERC8004Config {
  /** Enable ERC-8004 integration */
  enabled: boolean;

  /** Chain to use for registry operations (default: 'base') */
  registryChain?: string;

  /** Whether to use testnet contract addresses */
  testnet?: boolean;

  /** Auto-submit feedback after successful payments */
  autoFeedback?: boolean;

  /** Minimum reputation score to transact with (0-100, default: 0 = disabled) */
  minReputationScore?: number;

  /** Trusted reviewer addresses for reputation queries */
  trustedReviewers?: string[];

  /** Storage for feedback evidence: 'ipfs' | 'datauri' | 'none' */
  feedbackStorage?: 'ipfs' | 'datauri' | 'none';

  /** IPFS pinning config (required if feedbackStorage = 'ipfs') */
  ipfs?: {
    gateway: string;
    apiKey: string;
    provider: 'pinata' | 'web3storage';
  };

  /** Pre-registered agentId (skip registration if already registered) */
  agentId?: bigint;

  /** Custom RPC provider for registry chain (if different from main provider) */
  registryProvider?: ethers.Provider;
}

/** Options for registering a new agent */
export interface RegisterAgentOptions {
  name: string;
  description: string;
  services?: ServiceEndpoint[];
  image?: string;
  x402Support?: boolean;
  supportedTrust?: string[];
  metadata?: MetadataEntry[];
}

/** Options for submitting feedback */
export interface FeedbackOptions {
  /** Feedback value (will be scaled by valueDecimals) */
  value: number;
  /** Decimal precision (default: 2) */
  valueDecimals?: number;
  /** Primary tag (e.g., protocol name: "x402", "ucp") */
  tag1?: string;
  /** Secondary tag (e.g., response time bucket: "fast", "normal", "slow") */
  tag2?: string;
  /** Endpoint URI that was called */
  endpointURI?: string;
  /** Off-chain feedback file URI (IPFS or HTTPS) */
  feedbackURI?: string;
  /** keccak256 hash of feedback file for integrity */
  feedbackHash?: string;
}

/** Configuration for TrustGate pre-payment checks */
export interface TrustGateConfig {
  /** Minimum reputation score to allow payment (0-100) */
  minReputation: number;
  /** Only count feedback from these addresses */
  trustedReviewers?: string[];
  /** Trust model to use */
  trustModel?: 'reputation' | 'validation' | 'crypto-economic' | 'any';
  /** Whether to reject or warn on low reputation */
  mode?: 'reject' | 'warn';
}

/** Query parameters for agent discovery */
export interface DiscoveryQuery {
  /** Service capability to search for (e.g., "sentiment", "oracle") */
  capability?: string;
  /** Chain to search on */
  chain?: string;
  /** Minimum reputation score */
  minReputation?: number;
  /** Maximum number of results */
  limit?: number;
}

/** Result of a TrustGate check */
export interface TrustCheckResult {
  trusted: boolean;
  score: number;
  agentId?: bigint;
  reason?: string;
}

// ============================================================================
// UATL Types — Universal Agent Trust Layer (Multi-Chain)
// ============================================================================

/**
 * Universal Agent Identifier (UAI).
 * Extends ERC-8004's identifier format to support all chain namespaces via CAIP-2.
 * 
 * Format: {namespace}:{chainReference}:{registryAddress}:{agentId}
 * 
 * Examples:
 *   eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:42
 *   solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:AgentRegistry111111111111111111111111:42
 *   stacks:1:ST1PQHQKV0DCTD65DNAPG05EJCTS3R0V57WVHPWD.agent-trust:42
 */
export type UniversalAgentIdentifier = string;

/** Trust bridging strategy used for a specific chain */
export type TrustStrategy = 'erc8004' | 'native-program' | 'relayer-attested';

/** Agent's presence on a specific chain */
export interface ChainPresence {
  chain: string;                        // CAIP-2 chain identifier
  registryAddress: string;
  localAgentId: bigint;
  strategy: TrustStrategy;
}

/** Resolved agent identity with cross-chain presence */
export interface ResolvedAgent {
  canonicalUAI: UniversalAgentIdentifier;
  agentId: bigint;
  registrationFile: AgentRegistrationFile;
  chainPresence: ChainPresence[];
  aggregatedReputation?: AggregatedReputation;
}

/** Aggregated reputation across multiple chains */
export interface AggregatedReputation {
  /** Weighted average score (0-100) */
  score: number;
  /** Confidence in the score (0-1) based on feedback volume and chain diversity */
  confidence: number;
  /** Total feedback count across all chains */
  totalFeedbackCount: number;
  /** Per-chain breakdown */
  chainBreakdown: ChainReputationBreakdown[];
}

/** Reputation data from a single chain */
export interface ChainReputationBreakdown {
  chain: string;
  count: number;
  score: number;
  strategy: TrustStrategy;
}

/** Aggregation mode for cross-chain reputation queries */
export type ReputationAggregationMode =
  | 'hub-only'          // Only read from Base Hub (fastest, cheapest)
  | 'evm-aggregate'     // Read from all EVM chains via CCQ batch
  | 'full-aggregate';   // Read from all chains (CCQ + native + Relayer)

/** Options for cross-chain reputation queries */
export interface ReputationQueryOptions {
  mode?: ReputationAggregationMode;
  chains?: string[];
  trustedReviewers?: string[];
  /** Maximum staleness in seconds (default: 3600) */
  maxStaleness?: number;
}

/**
 * Trust attestation signed by the Veridex Relayer.
 * Used for Strategy 3 (Relayer-Attested Hybrid Bridge) in UATL.
 */
export interface TrustAttestation {
  attestationType: 'identity' | 'reputation' | 'validation';

  // Source chain info
  sourceChain: number;                  // Wormhole chain ID
  sourceRegistry: string;
  sourceBlockNumber: bigint;
  sourceBlockHash: string;

  // Agent identification
  agentId: bigint;
  canonicalUAI: UniversalAgentIdentifier;

  // Attested data (varies by type)
  data: {
    // Identity attestation
    agentURI?: string;
    agentWallet?: string;
    owner?: string;

    // Reputation attestation
    reputationCount?: bigint;
    reputationSummaryValue?: bigint;
    reputationSummaryDecimals?: number;
    clientAddresses?: string[];

    // Validation attestation
    validationResponse?: number;
    validatorAddress?: string;
  };

  // Relayer signature
  relayerAddress: string;
  signature: string;                    // EIP-712 signature
  timestamp: number;
  expiresAt: number;
}

// ============================================================================
// Well-Known File
// ============================================================================

/** Content of /.well-known/agent-registration.json */
export interface WellKnownAgentRegistration {
  agentId: number;
  canonicalUAI: UniversalAgentIdentifier;
  registrationFileURI: string;
  veridexRelayer?: string;
}

// ============================================================================
// Veridex-Specific Types (ServiceDirectory — NOT part of ERC-8004)
// ============================================================================

/** Service registration on the VeridexServiceDirectory contract */
export interface ServiceRegistration {
  agentId: bigint;
  endpointUrl: string;
  category: string;
  description: string;
  pricePerCall: bigint;
  paymentToken: string;
}

/** Service info returned from the VeridexServiceDirectory contract */
export interface ServiceInfo {
  serviceId: bigint;
  agentId: bigint;
  agent: string;
  endpointUrl: string;
  category: string;
  description: string;
  pricePerCall: bigint;
  paymentToken: string;
  active: boolean;
  registeredAt: bigint;
}
