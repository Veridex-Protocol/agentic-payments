/**
 * @packageDocumentation
 * @module AgentSDK
 * @description
 * The main entry point for the Veridex Agent SDK (@veridex/agentic-payments).
 *
 * This package provides a high-level, autonomous payment layer for AI agents, built on top of the
 * core Veridex SDK. It enables agents to manage spending limits, negotiate payments via x402,
 * and issue Universal Commerce Protocol (UCP) credentials.
 *
 * Exports:
 * - **createAgentWallet**: Factory function to initialize the agent.
 * - **AgentWallet**: The main class for agent operations.
 * - **Types**: Comprehensive type definitions for sessions, payments, and protocols.
 */
import { AgentWallet } from './AgentWallet';
import { AgentWalletConfig } from './types/agent';

export async function createAgentWallet(config: AgentWalletConfig): Promise<AgentWallet> {
  const wallet = new AgentWallet(config);
  await wallet.init();
  return wallet;
}

export * from './AgentWallet';
export * from './types/agent';
export * from './types/x402';
export * from './types/ucp';
export * from './types/mcp';
export * from './types/errors';

export * from './session/SessionKeyManager';
export * from './session/SpendingTracker';
export * from './session/SessionStorage';

export * from './x402/X402Client';
export * from './x402/PaymentParser';
export * from './x402/PaymentSigner';
export * from './x402/NonEvmPaymentSigner';
// CronosFacilitatorAdapter is NOT exported from main entry point due to node:crypto dependency
// Import it directly for server-side usage: import { CronosFacilitatorAdapter } from '@veridex/agentic-payments/x402/adapters/CronosFacilitatorAdapter';

export * from './ucp/CredentialProvider';
export * from './ucp/CapabilityNegotiator';

export * from './mcp/MCPServer';

export * from './routing/CrossChainRouter';
export * from './routing/FeeEstimator';
export * from './chains/ChainClient';
export * from './chains/EVMChainClient';
export * from './chains/SolanaChainClient';
export * from './chains/AptosChainClient';
export * from './chains/SuiChainClient';
export * from './chains/StarknetChainClient';
export * from './chains/StacksChainClient';
export * from './chains/MonadChainClient';
export * from './chains/AvalancheChainClient';
export * from './chains/ChainClientFactory';

export * from './session/StacksSpendingTracker';
// StacksFacilitatorAdapter is NOT exported from main entry point due to x402-stacks dependency
// Import it directly for server-side usage: import { StacksFacilitatorAdapter } from '@veridex/agentic-payments/x402/adapters/StacksFacilitatorAdapter';
export * from './routing/BridgeOrchestrator';

export * from './monitoring/AuditLogger';
export * from './monitoring/AlertManager';
export * from './monitoring/ComplianceExporter';
export * from './monitoring/BalanceCache';

// Agent-Safe Execution Control Plane
export * from './policy';
export * from './security';
export * from './trace';
export * from './escalation';

export * from './ucp/PaymentTokenizer';

export * from './react/hooks';

// Performance optimizations
export * from './performance';

// Oracle
export * from './oracle/PythOracle';
export * from './oracle/PythFeeds';

// DEX
export * from './routing/DEXAggregator';

// Universal Protocol Abstraction Layer (ADR-0025)
export * from './protocols/base';
export * from './protocols/x402';
export * from './protocols/ucp';
export * from './protocols/acp';
export * from './protocols/ap2';
export * from './protocols/mpp';

// Server Middleware (ADR-0024)
export * from './middleware/veridexPaywall';

// Next.js App Router adapter
export * from './middleware/nextAppRouter';

// Generic EVM Facilitator Adapter (Base, Ethereum, Solana via Coinbase x402)
export * from './x402/adapters/EVMFacilitatorAdapter';

// Identity & Reputation (ERC-8004 — chain-agnostic for all EVM chains)
export {
  // Clients
  IdentityClient,
  ReputationClient,
  ServiceDirectoryClient,
  RegistrationFileManager,
  TrustGate,
  AgentDiscovery,
  // Facade (backward-compatible)
  ERC8004Client,
  // Registration & Pipeline
  AgentRegistrar,
  ReputationPipeline,
  // Constants
  ERC8004_MAINNET_IDENTITY,
  ERC8004_MAINNET_REPUTATION,
  ERC8004_TESTNET_IDENTITY,
  ERC8004_TESTNET_REPUTATION,
  getERC8004Addresses,
} from './identity';
export type {
  // ERC-8004 standard types
  AgentRegistration,
  MetadataEntry,
  FeedbackEntry,
  FeedbackSummary,
  ValidationStatus,
  AgentRegistrationFile,
  ServiceEndpoint,
  AgentRegistryRef,
  ERC8004Config,
  RegisterAgentOptions,
  FeedbackOptions,
  TrustGateConfig,
  DiscoveryQuery,
  TrustCheckResult,
  // UATL types (multi-chain)
  UniversalAgentIdentifier,
  TrustStrategy,
  ChainPresence,
  ResolvedAgent,
  AggregatedReputation,
  ChainReputationBreakdown,
  ReputationAggregationMode,
  ReputationQueryOptions,
  TrustAttestation,
  WellKnownAgentRegistration,
  // Veridex-specific
  ServiceRegistration,
  // Legacy types (backward-compatible)
  AgentIdentity,
  AgentMetadata,
  FeedbackParams,
  ERC8004ClientConfig,
  AgentRegistrarConfig,
  RegistrationResult,
  AgentVisibility,
  AgentProfile,
  SettlementEvent,
  ServiceCallMetrics,
  ReputationPipelineConfig,
} from './identity';
// Note: ServiceInfo and ReputationSummary are already exported from MonadChainClient
// Use the identity module versions via: import { ... } from '@veridex/agent-sdk/identity'

// Re-export core SDK functions for frontend convenience and to avoid dual-package usage
export {
  createSDK,
  generateSecp256k1KeyPair,
  computeSessionKeyHash,
  deriveEncryptionKey,
  encrypt,
  // Feature Flags (multi-hub toggle)
  getFeatureFlags,
  setFeatureFlags,
  resetFeatureFlags,
  isMultiHubEnabled,
  getEffectivePrimaryHub,
} from '@veridex/sdk';
export type { FeatureFlags } from '@veridex/sdk';
