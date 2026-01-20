# Changelog

All notable changes to `@veridex/agentic-payments` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-20

### Added

#### Core Features
- **Session Key Management**
  - `SessionKeyManager` for creating, validating, and revoking session keys
  - `SpendingTracker` for daily and per-transaction limit enforcement
  - `SessionStorage` for encrypted key persistence
  - Support for 24-hour maximum session duration
  - Automatic daily limit reset with rolling window

- **x402 Protocol Support**
  - `X402Client` for automatic HTTP 402 payment handling
  - `PaymentParser` for parsing payment requirement headers
  - `PaymentSigner` with ERC-3009 support (transferWithAuthorization)
  - `NonceManager` for client-side nonce tracking

- **UCP Integration**
  - `UCPCredentialProvider` for Universal Credential Protocol support
  - `CapabilityNegotiator` for capability intersection calculation
  - `PaymentTokenizer` for generating and validating payment tokens
  - Token refresh and revocation mechanisms

- **MCP Server**
  - `MCPServer` for Model Context Protocol integration
  - Tools: `veridex_create_session_key`, `veridex_pay`, `veridex_check_balance`, `veridex_revoke_session`, `veridex_get_payment_history`
  - JSON Schema validation for all tool parameters

- **Multi-Chain Support**
  - `ChainClientFactory` for creating chain-specific clients
  - `EVMChainClient` - Base, Optimism, Arbitrum, Ethereum, Polygon, BSC, Avalanche
  - `SolanaChainClient` - Solana mainnet and devnet
  - `AptosChainClient` - Aptos mainnet and testnet
  - `SuiChainClient` - Sui mainnet and testnet
  - `StarknetChainClient` - Starknet mainnet and testnet

- **Oracle Integration**
  - `PythOracle` for real-time price feeds via Hermes API
  - `PythFeeds` registry for price feed IDs
  - Support for ETH, SOL, APT, SUI, STRK native token pricing

- **Cross-Chain Routing**
  - `CrossChainRouter` for finding optimal payment routes
  - `FeeEstimator` for gas and bridge fee calculation
  - `BridgeOrchestrator` for Wormhole integration

- **Monitoring & Compliance**
  - `AuditLogger` for payment audit trails
  - `AlertManager` with configurable spending thresholds
  - High-value transaction approval workflow (5-minute window)
  - Anomaly detection for unusual transaction patterns
  - Webhook notifications for alerts
  - `ComplianceExporter` for CSV/JSON export

- **Performance Optimizations**
  - `NonceManager` - Client-side nonce tracking
  - `TransactionQueue` - Batch transaction support
  - `TransactionPoller` - 2-second confirmation polling
  - `BalanceCache` - 10-second TTL caching

- **Error Handling**
  - `AgentPaymentError` with structured error codes
  - Remediation suggestions for all error types
  - Retry flag for transient errors
  - Exponential backoff (2s, 4s, 8s) for retries

- **React Hooks**
  - `useAgentWallet` - Wallet state management
  - `usePaymentHistory` - Transaction history with pagination
  - `useSessionStatus` - Real-time session status

- **Developer Experience**
  - Full TypeScript support with `.d.ts` generation
  - Dual ESM/CJS builds
  - Comprehensive README documentation
  - Example files for all major use cases

### Test Coverage
- 136 tests passing
- Property-based tests with fast-check
- Integration tests for full payment flows
- Unit tests for all modules

### Dependencies
- `@veridex/sdk` - Core SDK integration
- `ethers` - EVM interactions
- `@solana/web3.js` - Solana interactions
- `axios` - HTTP client for Pyth oracle
- `zod` - Schema validation

## [Unreleased]

### Planned
- Connection pooling for HTTP requests
- Parallel route finding optimization
- React hooks unit tests
- Cross-browser testing
- Migration guide from `@veridex/sdk`
- DEX integration for token swapping
- Cross-chain recovery mechanisms
