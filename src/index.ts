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
export * from './chains/ChainClientFactory';
export * from './routing/BridgeOrchestrator';

export * from './monitoring/AuditLogger';
export * from './monitoring/AlertManager';
export * from './monitoring/ComplianceExporter';
export * from './monitoring/BalanceCache';

export * from './ucp/PaymentTokenizer';

export * from './react/hooks';

