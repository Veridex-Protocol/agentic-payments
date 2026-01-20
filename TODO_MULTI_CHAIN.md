# TODO: Multi-Chain Support Implementation

- [x] **Phase 1: Structure & Interface Refinement**
  - [x] Move/Ensure `ChainClient.ts` is in the correct location (`src/chains/` preferred for Section 9).
  - [x] Add missing types/methods to `AgentChainClient` if needed for production grade (e.g., error handling patterns).

- [x] **Phase 2: EVM Chain Implementation**
  - [x] Implement `EVMChainClient` wrapping `@veridex/sdk/EVMClient`.
  - [x] Add agent-specific logic (e.g., specific gas estimation or price query mocks/placeholders).

- [x] **Phase 3: Solana Chain Implementation**
  - [x] Implement `SolanaChainClient` wrapping `@veridex/sdk/SolanaClient`.
  - [x] Ensure non-EVM key handling works or is correctly abstracted (Solana uses Ed25519).
  - [x] Add SOL price query placeholder.

- [x] **Phase 4: Move/Aptos/Sui Implementation**
  - [x] Implement `AptosChainClient`.
  - [x] Implement `SuiChainClient`.

- [x] **Phase 5: Starknet Implementation**
  - [x] Implement `StarknetChainClient`.

- [ ] **Phase 6: Integration & Verification**
  - [x] Update `CrossChainRouter` or a factory to use these clients.
  - [ ] Write a test or script to verify multi-chain balance fetching using the new clients.
  - [ ] Replace price oracles placeholders with robust solutions (Issue #50).
  - [ ] Run build and ensure no regressions.
