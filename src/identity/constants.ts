/**
 * @packageDocumentation
 * @module identity/constants
 * @description
 * Canonical ERC-8004 contract addresses and ABIs.
 * 
 * ERC-8004 registries are deployed as per-chain singletons — the SAME addresses
 * on every mainnet and every testnet. This is by design (CREATE2 deterministic deployment).
 * 
 * Addresses sourced from: https://github.com/erc-8004/erc-8004-contracts
 * Spec: https://eips.ethereum.org/EIPS/eip-8004
 */

// ============================================================================
// Canonical Singleton Addresses
// ============================================================================

/** ERC-8004 Identity Registry — same address on ALL mainnets */
export const ERC8004_MAINNET_IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

/** ERC-8004 Reputation Registry — same address on ALL mainnets */
export const ERC8004_MAINNET_REPUTATION = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

/** ERC-8004 Identity Registry — same address on ALL testnets */
export const ERC8004_TESTNET_IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

/** ERC-8004 Reputation Registry — same address on ALL testnets */
export const ERC8004_TESTNET_REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

// Validation Registry addresses not yet published (spec still under active update)
// export const ERC8004_MAINNET_VALIDATION = '';
// export const ERC8004_TESTNET_VALIDATION = '';

/**
 * Resolve canonical ERC-8004 addresses for a given network.
 */
export function getERC8004Addresses(testnet: boolean) {
  return {
    identityRegistry: testnet ? ERC8004_TESTNET_IDENTITY : ERC8004_MAINNET_IDENTITY,
    reputationRegistry: testnet ? ERC8004_TESTNET_REPUTATION : ERC8004_MAINNET_REPUTATION,
  };
}

// ============================================================================
// Chains where ERC-8004 singletons are deployed
// ============================================================================

export const ERC8004_DEPLOYED_CHAINS = {
  mainnet: [
    'ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'linea', 'megaeth', 'monad',
  ],
  testnet: [
    'ethereum-sepolia', 'base-sepolia', 'polygon-amoy', 'arbitrum-sepolia',
    'optimism-sepolia', 'monad-testnet',
  ],
} as const;

// ============================================================================
// Veridex-Specific Contract Addresses (NOT part of ERC-8004 standard)
// ============================================================================

/** VeridexServiceDirectory — Veridex's own agent marketplace contract */
export const VERIDEX_SERVICE_DIRECTORY = {
  'monad-testnet': '0x0D2B4193e78107678a5aC29d795e0EcD361aE3A7',
} as Record<string, string>;

// ============================================================================
// ABIs — Identity Registry (IdentityRegistryUpgradeable)
// ============================================================================

export const IDENTITY_REGISTRY_ABI = [
  // Registration
  'function register(string agentURI) returns (uint256)',
  'function register(string agentURI, tuple(string key, string value)[] metadata) returns (uint256)',

  // Read — ERC-721 standard
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',

  // Read — ERC-8004 specific
  'function agentURI(uint256 agentId) view returns (string)',
  'function agentWallet(uint256 agentId) view returns (address)',
  'function getMetadata(uint256 agentId, string key) view returns (string)',

  // Write — URI and wallet management
  'function setAgentURI(uint256 agentId, string newURI)',
  'function setAgentWallet(uint256 agentId, address wallet, uint256 deadline, bytes signature)',
  'function unsetAgentWallet(uint256 agentId)',
  'function setMetadata(uint256 agentId, string key, string value)',

  // Events
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event AgentURIUpdated(uint256 indexed agentId, string newURI)',
  'event AgentWalletSet(uint256 indexed agentId, address wallet)',
  'event AgentWalletUnset(uint256 indexed agentId)',
  'event MetadataUpdated(uint256 indexed agentId, string key, string value)',
] as const;

// ============================================================================
// ABIs — Reputation Registry (ReputationRegistryUpgradeable)
// ============================================================================

export const REPUTATION_REGISTRY_ABI = [
  // Write
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2)',
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpointURI, string feedbackURI, bytes32 feedbackHash)',
  'function revokeFeedback(uint256 agentId, uint256 feedbackIndex)',
  'function appendResponse(uint256 agentId, address clientAddress, uint256 feedbackIndex, string responseURI, bytes32 responseHash)',

  // Read
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint256 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function readFeedback(uint256 agentId, address clientAddress, uint256 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
  'function getClients(uint256 agentId) view returns (address[])',
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint256)',

  // Events
  'event FeedbackGiven(uint256 indexed agentId, address indexed client, int128 value, uint8 valueDecimals)',
  'event FeedbackRevoked(uint256 indexed agentId, address indexed client, uint256 feedbackIndex)',
  'event ResponseAppended(uint256 indexed agentId, address indexed client, uint256 feedbackIndex)',
] as const;

// ============================================================================
// ABIs — Validation Registry (ValidationRegistryUpgradeable) — Phase 3
// ============================================================================

export const VALIDATION_REGISTRY_ABI = [
  'function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) returns (bytes32)',
  'function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)',
  'function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint256 count, uint256 averageResponse)',
  'function getAgentValidations(uint256 agentId) view returns (bytes32[])',
] as const;

// ============================================================================
// ABIs — VeridexServiceDirectory (Veridex-specific, NOT ERC-8004)
// ============================================================================

export const SERVICE_DIRECTORY_ABI = [
  'function registerService(uint256 agentId, string endpointUrl, string category, string description, uint256 pricePerCall, address paymentToken)',
  'function deactivateService(uint256 agentId, uint256 serviceIndex)',
  'function activateService(uint256 agentId, uint256 serviceIndex)',
  'function updateService(uint256 agentId, uint256 serviceIndex, string endpointUrl, string description, uint256 pricePerCall, address paymentToken)',
  'function getServicesByCategory(string category) view returns (tuple(uint256 serviceId, uint256 agentId, address agent, string endpointUrl, string category, string description, uint256 pricePerCall, address paymentToken, bool active, uint256 registeredAt)[])',
  'function getServicesByAgent(uint256 agentId) view returns (tuple(uint256 serviceId, uint256 agentId, address agent, string endpointUrl, string category, string description, uint256 pricePerCall, address paymentToken, bool active, uint256 registeredAt)[])',
  'function getActiveServices() view returns (tuple(uint256 serviceId, uint256 agentId, address agent, string endpointUrl, string category, string description, uint256 pricePerCall, address paymentToken, bool active, uint256 registeredAt)[])',
  'function getService(uint256 serviceId) view returns (tuple(uint256 serviceId, uint256 agentId, address agent, string endpointUrl, string category, string description, uint256 pricePerCall, address paymentToken, bool active, uint256 registeredAt))',
  'function totalServices() view returns (uint256)',
  'function totalCategories() view returns (uint256)',
  'event ServiceRegistered(uint256 indexed serviceId, uint256 indexed agentId, address indexed agent, string category)',
  'event ServiceDeactivated(uint256 indexed serviceId, uint256 indexed agentId)',
] as const;

// ============================================================================
// Default Configuration
// ============================================================================

/** Default registry chain for ERC-8004 operations */
export const DEFAULT_REGISTRY_CHAIN = 'base';

/** Supported trust models */
export const TRUST_MODELS = ['reputation', 'validation', 'crypto-economic', 'any'] as const;

/** Supported feedback storage backends */
export const FEEDBACK_STORAGE_BACKENDS = ['ipfs', 'datauri', 'none'] as const;

/** CAIP-2 namespace prefixes for supported chain families */
export const CAIP2_NAMESPACES = {
  evm: 'eip155',
  solana: 'solana',
  aptos: 'aptos',
  sui: 'sui',
  stacks: 'stacks',
  starknet: 'starknet',
} as const;
