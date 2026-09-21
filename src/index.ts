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
import type { AgentWalletConfig } from './types/agent';

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
export * from './x402/tokens';
export * from './x402/NonEvmPaymentSigner';
export { PlatformPaymentsAdapter } from './platform/PlatformPaymentsAdapter';
export type { SponsoredExecutionResult } from './platform/PlatformPaymentsAdapter';
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
export * from './chains/StellarChainClient';
export * from './chains/ChainClientFactory';

export * from './session/StacksSpendingTracker';
// StacksFacilitatorAdapter is NOT exported from main entry point due to x402-stacks dependency
// Import it directly for server-side usage: import { StacksFacilitatorAdapter } from '@veridex/agentic-payments/x402/adapters/StacksFacilitatorAdapter';
// StellarFacilitatorAdapter: import directly for server-side usage:
// import { StellarFacilitatorAdapter, buildStellarPaymentRequirements } from '@veridex/agentic-payments/x402/adapters/StellarFacilitatorAdapter';
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
export * from './wallets/VeridexGoatWalletWrapper';

export * from './ucp/PaymentTokenizer';

export * from './react/hooks';

// Performance optimizations
export * from './performance';

// Oracle
export * from './oracle/PythOracle';
export * from './oracle/PythFeeds';
export * from './oracle/StalePriceError';

// DEX
export {
  DEXAggregator,
  type SwapQuote,
  type SwapHop,
  type TokenInfo as DexTokenInfo,
} from './routing/DEXAggregator';

// Universal Protocol Abstraction Layer (ADR-0025)
export * from './protocols/base';
export * from './protocols/x402';
export * from './protocols/ucp';
export * from './protocols/acp';
export * from './protocols/ap2';
export * from './protocols/mpp';

// Hardened settlement gateway — bring-your-own protected RPC (Gap 4)
export * from './protected/ProtectedRpc';
// Policy attestation enforced at the payment signer (Gap 1)
export {
  canonicalJson,
  sha256Hex,
  computeIntentHash,
  canonicalAttestationPayload,
  signAttestation,
  PaymentAttestationGuard,
  type PaymentIntent as AttestedPaymentIntent,
  type PolicyAttestation,
  type AttestationSigner,
  type AttestationVerifier,
  type TeeQuoteVerifier,
  type AttestationEnforcement,
  type PaymentAttestationGuardOptions,
} from './protected/PolicyAttestation';

// Server Middleware (ADR-0024)
export * from './middleware/veridexPaywall';

// Next.js App Router adapter
export * from './middleware/nextAppRouter';

// Generic EVM Facilitator Adapter (Base, Ethereum, Solana via Coinbase x402)
export * from './x402/adapters/EVMFacilitatorAdapter';
