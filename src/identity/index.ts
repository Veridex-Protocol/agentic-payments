// =============================================================================
// Constants & ABIs
// =============================================================================
export {
  ERC8004_MAINNET_IDENTITY,
  ERC8004_MAINNET_REPUTATION,
  ERC8004_TESTNET_IDENTITY,
  ERC8004_TESTNET_REPUTATION,
  getERC8004Addresses,
  ERC8004_DEPLOYED_CHAINS,
  VERIDEX_SERVICE_DIRECTORY,
  IDENTITY_REGISTRY_ABI,
  REPUTATION_REGISTRY_ABI,
  VALIDATION_REGISTRY_ABI,
  SERVICE_DIRECTORY_ABI,
  DEFAULT_REGISTRY_CHAIN,
  TRUST_MODELS,
  FEEDBACK_STORAGE_BACKENDS,
  CAIP2_NAMESPACES,
} from './constants';

// =============================================================================
// Types (ERC-8004 standard + UATL + Veridex-specific)
// =============================================================================
export type {
  // On-chain types
  AgentRegistration,
  MetadataEntry,
  FeedbackEntry,
  FeedbackSummary,
  ValidationStatus,

  // Registration file schema
  AgentRegistrationFile,
  ServiceEndpoint,
  AgentRegistryRef,

  // SDK config
  ERC8004Config,
  RegisterAgentOptions,
  FeedbackOptions,
  TrustGateConfig,
  DiscoveryQuery,
  TrustCheckResult,

  // UATL types
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
  ServiceInfo,
} from './types';

// =============================================================================
// Clients — ERC-8004 Standard (chain-agnostic for any EVM chain)
// =============================================================================
export { IdentityClient } from './IdentityClient';
export { ReputationClient } from './ReputationClient';

// =============================================================================
// Clients — Veridex-Specific
// =============================================================================
export { ServiceDirectoryClient } from './ServiceDirectoryClient';

// =============================================================================
// Registration File Management
// =============================================================================
export { RegistrationFileManager } from './RegistrationFileManager';
export type { ValidationResult } from './RegistrationFileManager';

// =============================================================================
// Higher-Level Modules
// =============================================================================
export { TrustGate } from './TrustGate';
export { AgentDiscovery } from './AgentDiscovery';

// =============================================================================
// Facade (backward-compatible unified client)
// =============================================================================
export { ERC8004Client } from './ERC8004Client';
export type {
  AgentIdentity,
  AgentMetadata,
  ReputationSummary,
  FeedbackParams,
  ERC8004ClientConfig,
} from './ERC8004Client';

// =============================================================================
// Registration & Pipeline (hackathon / demo flow)
// =============================================================================
export { AgentRegistrar } from './AgentRegistrar';
export type {
  AgentRegistrarConfig,
  RegistrationResult,
  AgentVisibility,
  AgentProfile,
} from './AgentRegistrar';

export { ReputationPipeline } from './ReputationPipeline';
export type {
  SettlementEvent,
  ServiceCallMetrics,
  ReputationPipelineConfig,
} from './ReputationPipeline';
