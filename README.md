# @veridex/agentic-payments

[![npm version](https://img.shields.io/npm/v/@veridex/agentic-payments.svg)](https://www.npmjs.com/package/@veridex/agentic-payments)
[![Tests](https://img.shields.io/badge/tests-372%20passing-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**The universal payment, identity, and reputation layer for AI agents.** One SDK. Any protocol. Any chain.

Give your agent a wallet with human-set spending limits, on-chain identity (ERC-8004), trust-gated payments, automatic protocol detection, policy-gated execution, cryptographic audit trails, and multi-chain payment signing — from Solana to Starknet.

```bash
npm install @veridex/agentic-payments
```

```typescript
import { createAgentWallet } from '@veridex/agentic-payments';

const agent = await createAgentWallet({
  masterCredential: {
    credentialId: process.env.CREDENTIAL_ID!,
    publicKeyX: BigInt(process.env.PUBLIC_KEY_X!),
    publicKeyY: BigInt(process.env.PUBLIC_KEY_Y!),
    keyHash: process.env.KEY_HASH!,
  },
  session: {
    dailyLimitUSD: 50,
    perTransactionLimitUSD: 5,
    expiryHours: 24,
    allowedChains: [10004], // Base Sepolia
  },
});

// Auto-detects protocol (x402/UCP/ACP/AP2/MPP), signs payment, returns data
const response = await agent.fetch('https://api.merchant.com/premium-data');
const data = await response.json();

// Direct payment
const receipt = await agent.pay({
  chain: 10004,
  token: 'USDC',
  amount: '1000000', // 1 USDC (6 decimals)
  recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f5A234',
});
console.log('Tx:', receipt.txHash);

// Check remaining budget
const status = agent.getSessionStatus();
console.log(`Spent: $${status.totalSpentUSD} / $${status.limits!.dailyLimitUSD}`);
```

## Frontend Requirement (Passkey Creation)

> **Important:** While the Agent SDK itself runs server-side (Node.js), the **master passkey credential** it requires must be created on a **browser frontend** first. WebAuthn passkeys can only be registered via native OS biometric prompts (FaceID, TouchID, Windows Hello) in a secure browser context.

**Typical flow:**
1. **Frontend (browser):** Human creates a passkey wallet using `@veridex/sdk` → `sdk.passkey.register()` (triggers biometric prompt)
2. **Frontend (browser):** Human configures a spending budget and session key duration
3. **Frontend (browser):** Dashboard generates a session key and sends the `masterCredential` + session config to the agent's backend
4. **Backend (Node.js):** Agent uses `createAgentWallet({ masterCredential, session })` to operate autonomously within the human-set budget

The `masterCredential` fields (`credentialId`, `publicKeyX`, `publicKeyY`, `keyHash`) come from the frontend passkey registration. The agent never has access to the passkey private key — it only gets a time-limited session key with spending limits.

For a complete frontend example, see the [dashboard](https://github.com/Veridex-Protocol/demo/tree/main/dashboard) which handles passkey creation, budget configuration, and session key delivery to the agent.

## How It Works

```
Human sets limits → Agent gets session key → Makes autonomous payments
    ↓                    ↓                            ↓
Budget configured   secp256k1 key derived    402 Payment Required
    ↓                    ↓                            ↓
Session created     Private key encrypted    SDK parses payment terms
(dailyLimit, etc.)  with passkey owner's     and checks spending limits
                    credentialId                      ↓
                                             Policy Engine evaluates
                                                      ↓
                                             Signs with session key
                                                      ↓
                                             Payment proof → Data returned
                                                      ↓
                                             Trace recorded → Evidence bundle
```

The SDK enforces **human-defined spending limits** via session keys. The agent can spend up to the daily/per-transaction limits without human intervention. All payments are cryptographically signed, policy-gated, and produce verifiable audit trails.

## Protocol Support

| Protocol | Creator | Status | Priority | Use Case |
|----------|---------|--------|----------|----------|
| **x402** | Coinbase/Cloudflare | ✅ Full | 70 | HTTP micropayments (402 Payment Required) |
| **UCP** | Google/Shopify | ✅ Full | 100 | Commerce/search integration |
| **ACP** | OpenAI/Stripe | ✅ Detection + Handler | 90 | ChatGPT ecosystem payments |
| **MPP** | Tempo | ✅ Detection + Handler | 85 | Micropayments (charge + session intents) |
| **AP2** | Google | ✅ Detection + Handler | 80 | A2A mandate delegation |

Priority order: UCP (100) > ACP (90) > MPP (85) > AP2 (80) > x402 (70). The SDK auto-detects which protocol a merchant uses and routes accordingly.

### Protocol Registry

The `ProtocolRegistry` provides formal capability declarations for intelligent protocol selection:

```typescript
import { ProtocolRegistry } from '@veridex/agentic-payments';

const registry = new ProtocolRegistry();

// Find protocols supporting specific capabilities
const escrowProtocols = registry.findByCapabilities(['escrow', 'refund']);

// Find the best protocol for requirements
const best = registry.findBest({
  capabilities: ['one_time_payment', 'cross_chain'],
  chainId: 10004,
  token: 'USDC',
  amountUSD: 5,
});
```

Supported capabilities: `one_time_payment`, `subscription`, `streaming`, `escrow`, `refund`, `partial_refund`, `prepaid_session`, `multi_token`, `cross_chain`, `gasless`, `eip712_signing`, `reputational_feedback`, `metered_billing`, `mandate_based`.

### PaymentIntent (Universal Normalization)

Every protocol converts its native payment challenge into a protocol-agnostic `PaymentIntent`:

```typescript
import { createPaymentIntent, intentToProposedAction } from '@veridex/agentic-payments';

const intent = createPaymentIntent('x402', costEstimate, 'https://api.example.com/data', {
  recipient: '0x742d...',
  ttlMs: 300_000,
});

// Convert to ProposedAction for policy evaluation
const action = intentToProposedAction(intent);
```

### SettlementVerifier

Confirms payments actually settled on-chain after execution:

```typescript
import { SettlementVerifier, EVMSettlementStrategy } from '@veridex/agentic-payments';

const verifier = new SettlementVerifier({
  rpcEndpoints: { 10004: 'https://sepolia.base.org' },
  confirmations: 1,
});

verifier.registerStrategy(new EVMSettlementStrategy('x402', {
  10004: 'https://sepolia.base.org',
}));

const proof = await verifier.verify(settlement, traceHash);
```

## Chain Support

| Chain | Family | Signing | Payment Signer | Wormhole ID |
|-------|--------|---------|----------------|-------------|
| **Base / Ethereum / Optimism / Arbitrum / Polygon** | EVM | EIP-712 / ERC-3009 | `PaymentSigner` | 30 / 2 / 24 / 23 / 5 |
| **Monad** | EVM | EIP-712 / ERC-3009 | `PaymentSigner` | 10048 |
| **Solana** | Solana | Ed25519 | `NonEvmPaymentSigner` + custom `ChainSigner` | 1 |
| **Aptos** | Aptos | Ed25519 | `NonEvmPaymentSigner` + custom `ChainSigner` | 22 |
| **Sui** | Sui | secp256k1 | `NonEvmPaymentSigner` + custom `ChainSigner` | 21 |
| **Starknet** | Starknet | Stark ECDSA | `NonEvmPaymentSigner` + custom `ChainSigner` | 50001 |
| **Stacks** | Stacks | secp256k1 | `NonEvmPaymentSigner` + custom `ChainSigner` | 60 |

All chains support mainnet + testnet/devnet networks.

## Agent-Safe Execution Control Plane

The SDK includes a complete safety framework that evaluates every proposed action before execution.

### Policy Engine

Every payment flows through the `PolicyEngine` before execution:

```typescript
import { PolicyEngine, SpendingLimitRule, VelocityRule } from '@veridex/agentic-payments';

const engine = new PolicyEngine();
engine.addRule(new SpendingLimitRule());
engine.addRule(new VelocityRule({ maxPerMinute: 5, maxPerHour: 50 }));

const verdict = await engine.evaluate(proposedAction, context);
// → { verdict: 'allow' | 'deny' | 'escalate', reasons: [...] }
```

**8 built-in rules:** `SpendingLimitRule`, `VelocityRule`, `AssetWhitelistRule`, `ChainWhitelistRule`, `ProtocolWhitelistRule`, `CounterpartyRule`, `TimeWindowRule`, `HumanApprovalRule`.

### Security Firewall

Detects prompt injection, tool poisoning, secret exfiltration, and anomalous patterns:

```typescript
import {
  InjectionDetector,
  ToolSanitizer,
  OutputGuard,
  AnomalyDetector,
} from '@veridex/agentic-payments';

// Detect prompt injection in MCP tool inputs
const detector = new InjectionDetector();
const result = detector.detect(userInput);

// Strip hidden instructions from MCP tool descriptions
const sanitizer = new ToolSanitizer(detector);
const sanitized = sanitizer.sanitizeToolDescription(tool);

// Pin tool descriptions to detect rug-pulls
sanitizer.pinToolDescriptions([tool1, tool2]);
const validation = sanitizer.validatePins([tool1, tool2]);

// Scan outputs for leaked secrets
const guard = new OutputGuard();
const scan = guard.scanForSecrets(outputText);

// Detect anomalous transaction patterns
const anomaly = new AnomalyDetector({ baselineWindowMs: 7 * 24 * 60 * 60 * 1000 });
const analysis = anomaly.analyze(action, history, Date.now());
```

### Trace & Evidence

Cryptographically verifiable audit trail for every agent decision:

```typescript
import { TraceInterceptor, EvidenceBundle } from '@veridex/agentic-payments';

const interceptor = new TraceInterceptor(storageAdapter);
const trace = await interceptor.captureTrace({
  traceId: 'unique-id',
  agentId: 'agent-1',
  toolCalls: [{ name: 'veridex_pay', args: { ... }, result: { ... } }],
  reasoning: { prompt: '...', response: '...' },
});

const bundle = new EvidenceBundle(trace);
const evidence = bundle.build();
```

### Storage Adapters

8 storage backends for trace data:

| Adapter | Backend | Use Case |
|---------|---------|----------|
| `MemoryStorage` | In-memory | Development, testing |
| `JSONFileStorage` | Local filesystem | Local development |
| `PostgresStorage` | PostgreSQL | Self-hosted production |
| `IPFSStorage` | IPFS (Kubo/Pinata/Infura) | Decentralized storage |
| `ArweaveStorage` | Arweave permaweb | Immutable audit trails |
| `FilecoinStorage` | Filecoin Cloud (Synapse SDK) | PDP-verified durability |
| `StorachaStorage` | Storacha (@storacha/client) | UCAN-authorized uploads |
| `AkaveStorage` | Akave | Decentralized cloud |

```typescript
import { MemoryStorage, PostgresStorage, FilecoinStorage, StorachaStorage } from '@veridex/agentic-payments';

// In-memory (development)
const memory = new MemoryStorage();

// PostgreSQL (production)
const postgres = new PostgresStorage({ db: pool, tableName: 'veridex_traces' });

// Filecoin Cloud via Synapse SDK
import { Synapse } from '@filoz/synapse-sdk';
const synapse = Synapse.create({ account: privateKeyToAccount('0x...'), source: 'veridex' });
const filecoin = new FilecoinStorage({ client: synapse.storage });

// Storacha via @storacha/client
import * as Client from '@storacha/client';
const storachaClient = await Client.create();
const storacha = new StorachaStorage({ client: storachaClient });
```

### Escalation & Circuit Breaker

```typescript
import { EscalationManager, CircuitBreaker } from '@veridex/agentic-payments';

// Human-in-the-loop approval
const escalation = new EscalationManager(5 * 60 * 1000); // 5 min timeout
const ticket = escalation.escalate(proposedAction, verdict);
escalation.approve(ticket.id, 'admin@company.com');

// Circuit breaker — halts agent after repeated failures
const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
breaker.on('open', () => console.warn('Circuit opened — agent halted'));
```

## Core Modules

### Agent Wallet (Primary API)

The `AgentWallet` is the central orchestrator. Create one via `createAgentWallet()`:

```typescript
import { createAgentWallet } from '@veridex/agentic-payments';

const agent = await createAgentWallet({
  // Master passkey credential (from @veridex/sdk passkey registration)
  masterCredential: {
    credentialId: process.env.CREDENTIAL_ID!,
    publicKeyX: BigInt(process.env.PUBLIC_KEY_X!),
    publicKeyY: BigInt(process.env.PUBLIC_KEY_Y!),
    keyHash: process.env.KEY_HASH!,
  },
  // Session key budget and duration
  session: {
    dailyLimitUSD: 100,
    perTransactionLimitUSD: 25,
    expiryHours: 24,
    allowedChains: [10004, 10005], // Base Sepolia + Op Sepolia
  },
  // Optional: relayer for gasless transactions
  relayerUrl: 'https://relayer.veridex.network',
  relayerApiKey: 'your-api-key',
});
```

#### Automatic Protocol Payments (fetch)

```typescript
// The SDK auto-detects x402/UCP/ACP/AP2/MPP and handles payment transparently
const response = await agent.fetch('https://paid-api.example.com/market-data');
const data = await response.json();

// With payment approval callback
const response = await agent.fetch('https://merchant.com/api/data', {
  onBeforePayment: async (estimate) => {
    console.log(`Cost: $${estimate.amountUSD} via ${estimate.scheme}`);
    return estimate.amountUSD <= 5; // approve if under $5
  },
  maxAutoApproveUSD: 10, // auto-reject anything over $10
});

// Force a specific protocol
const response = await agent.fetch('https://merchant.com/api', {
  protocol: 'ucp',
});

// Estimate cost without paying
const estimate = await agent.estimateCost('https://merchant.com/api');
console.log(`Would cost: $${estimate?.amountUSD}`);
```

#### Direct Payments (pay)

```typescript
// Pay with USDC on Base Sepolia
const receipt = await agent.pay({
  chain: 10004,         // Base Sepolia Wormhole chain ID
  token: 'USDC',        // 'USDC', 'ETH', or 'native'
  amount: '5000000',    // 5 USDC (6 decimals, as string)
  recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f5A234',
});
console.log('Tx hash:', receipt.txHash);
console.log('Status:', receipt.status); // 'confirmed'

// Pay with native ETH
const ethReceipt = await agent.pay({
  chain: 10004,
  token: 'ETH',
  amount: '10000000000000000', // 0.01 ETH (18 decimals)
  recipient: '0x...',
});
```

#### Session Status & Monitoring

```typescript
// Check session status
const status = agent.getSessionStatus();
console.log('Session valid:', status.isValid);
console.log('Wallet address:', status.address);
console.log('Daily limit:', `$${status.limits!.dailyLimitUSD}`);
console.log('Spent today:', `$${status.totalSpentUSD.toFixed(2)}`);
console.log('Remaining:', `$${status.remainingDailyLimitUSD.toFixed(2)}`);
console.log('Expires:', new Date(status.expiry).toLocaleString());

// Set up spending alerts
agent.onSpendingAlert((alert) => {
  console.warn(`[${alert.type}] ${alert.message}`);
  console.warn(`Spent: $${alert.dailySpentUSD} / $${alert.dailyLimitUSD}`);
});

// View payment history
const history = await agent.getPaymentHistory({ limit: 20, chain: 10004 });
for (const payment of history) {
  console.log(`${payment.timestamp}: ${payment.token} ${payment.amount} → ${payment.recipient}`);
}

// Export audit log
const jsonLog = await agent.exportAuditLog('json');
const csvLog = await agent.exportAuditLog('csv');
```

#### Balances

```typescript
// Single chain balance
const balances = await agent.getBalance(10004); // Base Sepolia
for (const entry of balances) {
  console.log(`${entry.token.symbol}: ${entry.formatted}`);
}

// Multi-chain portfolio
const portfolio = await agent.getMultiChainBalance();
console.log('Total USD value:', portfolio.totalUsdValue);
```

#### Session Lifecycle

```typescript
// Import an existing session (e.g., from a frontend)
await agent.importSession(sessionData);

// Revoke when done
await agent.revokeSession();
```

### Session Key Management (Low-Level)

```typescript
import { SessionKeyManager } from '@veridex/agentic-payments';
import type { PasskeyCredential } from '@veridex/sdk';

const manager = new SessionKeyManager();

// Create session — derives secp256k1 key, encrypts with credentialId
const masterKey: PasskeyCredential = {
  credentialId: 'abc123',
  publicKeyX: BigInt('0x...'),
  publicKeyY: BigInt('0x...'),
  keyHash: '0x...',
};

const session = await manager.createSession(masterKey, {
  dailyLimitUSD: 100,
  perTransactionLimitUSD: 25,
  expiryTimestamp: Date.now() + 8 * 60 * 60 * 1000, // 8 hours
  allowedChains: [10004, 10005],
});

// Check limits before payment
const check = manager.checkLimits(session, 20); // $20 transaction
if (check.allowed) {
  await manager.recordSpending(session, 20);
  console.log('Remaining today:', check.remainingDailyLimitUSD);
} else {
  console.log('Blocked:', check.reason);
}

// Check session validity
console.log('Valid:', manager.isSessionValid(session));

// Get the session wallet (ethers.Wallet) for signing
const wallet = await manager.getSessionWallet(session, masterKey.credentialId);
console.log('Session address:', wallet.address);

// Revoke
await manager.revokeSession(session.keyHash);
```

### x402 Payment Signing

**EVM chains** use EIP-712 typed data signing (ERC-3009 token authorization):

```typescript
import { PaymentSigner } from '@veridex/agentic-payments';

const signer = new PaymentSigner();
const payment = await signer.sign(parsedRequest, session);
// → EIP-712 signature for USDC transferWithAuthorization
```

**Non-EVM chains** use chain-native signing with a canonical JSON message:

```typescript
import { NonEvmPaymentSigner } from '@veridex/agentic-payments';
import type { ChainSigner } from '@veridex/agentic-payments';

// Implement ChainSigner for your chain
const solanaChainSigner: ChainSigner = {
  signMessage: async (message: Uint8Array) => {
    // Sign with Ed25519 and return hex string
    return hexSignature;
  },
  getAddress: () => 'HSm5UoHcNoHSpoadynxdLLoE1inStzJQd2kyJhn5aVJT',
};

const signer = new NonEvmPaymentSigner();
const payment = await signer.sign(parsedRequest, session, solanaChainSigner);

// Check chain family
NonEvmPaymentSigner.isNonEvmChain('solana-devnet'); // true
NonEvmPaymentSigner.getChainFamily('solana-devnet'); // 'solana'
```

### x402 Payment Parsing

```typescript
import { PaymentParser } from '@veridex/agentic-payments';

const parser = new PaymentParser();

// Parse base64-encoded PAYMENT-REQUIRED header
const requirements = parser.parsePaymentRequired(headerValue);
// → { paymentRequirements: [{ scheme, network, maxAmountRequired, payTo, asset }] }
```

### Multi-Chain Agent Clients

```typescript
import { ChainClientFactory } from '@veridex/agentic-payments';

// Create agent chain clients from presets
const base = ChainClientFactory.createClient('base', 'testnet');
const solana = ChainClientFactory.createClient('solana', 'testnet');
const stacks = ChainClientFactory.createClient('stacks', 'testnet');
const monad = ChainClientFactory.createClient('monad', 'testnet');

// Custom RPC URL
const custom = ChainClientFactory.createClient('base', 'mainnet', 'https://my-rpc.com');
```

### ERC-8004 Identity & Reputation

The SDK implements the full [ERC-8004](https://www.8004.org/learn) standard for on-chain agent identity and reputation.

#### Enable via AgentWallet

```typescript
const agent = await createAgentWallet({
  masterCredential: { /* ... */ },
  session: {
    dailyLimitUSD: 50,
    perTransactionLimitUSD: 10,
    expiryHours: 24,
    allowedChains: [10004],
  },
  // Pass erc8004 config as extra property
  erc8004: {
    enabled: true,
    testnet: true,
    minReputationScore: 30,       // reject merchants below 30/100
    trustedReviewers: ['0x...'],  // only count feedback from these
  },
} as any); // erc8004 is an extension property

// Register on-chain identity (mints ERC-721 NFT)
const { agentId, agentURI } = await agent.register({
  name: 'Sentiment Analyzer',
  description: 'NLP-powered sentiment analysis',
  services: [{ name: 'analyze', endpoint: 'https://my-agent.com/api' }],
});
console.log(`Registered agent #${agentId}`);

// Get identity
const identity = await agent.getIdentity();
console.log('Agent ID:', agent.getAgentId());

// Submit feedback for another agent
await agent.submitFeedback(otherAgentId, {
  value: 5,
  tags: ['fast', 'accurate'],
});

// Get reputation score
const score = await agent.getReputationScore(otherAgentId);
console.log(`Reputation: ${score}/100`);

// Discover agents
const agents = await agent.discover({ category: 'sentiment' });

// Resolve agent from URL
const resolved = await agent.resolveAgent('https://my-agent.com');

// Check merchant trust before paying
const trust = await agent.checkMerchantTrust('https://merchant.com');
console.log('Trusted:', trust.trusted, 'Score:', trust.score);
```

#### Modular Clients (Direct Usage)

```typescript
import {
  IdentityClient,
  ReputationClient,
  RegistrationFileManager,
  TrustGate,
  AgentDiscovery,
} from '@veridex/agentic-payments';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
const signer = new ethers.Wallet(privateKey, provider);

// Identity client
const identity = new IdentityClient(provider, signer, { testnet: true });
const { agentId, agentURI } = await identity.registerWithFile({
  name: 'My Agent',
  description: 'Does useful things',
  services: [{ name: 'api', endpoint: 'https://my-agent.com/api' }],
});

// Reputation client
const reputation = new ReputationClient(provider, signer, { testnet: true });
const score = await reputation.getReputationScore(agentId);
const summary = await reputation.getSummary(agentId, []);

// Trust gate
const trustGate = new TrustGate(reputation, identity, {
  minReputation: 30,
  trustModel: 'reputation',
  mode: 'reject',
});
const result = await trustGate.checkMerchantTrust('https://merchant.com');

// Agent discovery
const discovery = new AgentDiscovery(identity, reputation);
const resolved = await discovery.resolve('https://my-agent.com');

// Registration file management
const file = RegistrationFileManager.buildRegistrationFile({
  name: 'My Agent',
  description: 'Does cool things',
  services: [{ name: 'api', endpoint: 'https://my-agent.com/api' }],
});
const { valid, errors } = RegistrationFileManager.validate(file);
const dataURI = RegistrationFileManager.buildDataURI(file);
```

### Server Middleware (Merchant Side)

```typescript
import { veridexPaywall, createPaywallHandler } from '@veridex/agentic-payments';

// Express middleware
app.use('/api/premium', veridexPaywall({
  amount: '1000000',   // 1 USDC (6 decimals)
  network: 'base-sepolia',
  asset: 'USDC',
  recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f5A234',
}));

// Or as a handler function (works with Next.js API routes)
const handler = createPaywallHandler({
  amount: '1000000',
  network: 'base-sepolia',
  asset: 'USDC',
  recipient: '0x...',
});
// Returns true if payment is valid, false otherwise
const paid = await handler(req, res);
```

### Hardened MCP Server

```typescript
import { MCPServer } from '@veridex/agentic-payments';

const server = new MCPServer(agent, {
  allowedTools: ['veridex_pay', 'veridex_check_balance'],
  toolSpendingLimits: { veridex_pay: 10 }, // $10 max per tool call
  sanitizeDescriptions: true,  // Strip hidden instructions
  pinDescriptions: true,       // Detect tool description rug-pulls
  scanInputs: true,            // Injection detection on inputs
  scanOutputs: true,           // Secret scanning on outputs
});

const tools = server.getTools();
// → veridex_pay, veridex_check_balance (filtered by allowedTools)
```

### Monitoring

```typescript
import { AlertManager, AuditLogger, ComplianceExporter } from '@veridex/agentic-payments';

// Alert manager (constructor takes no args)
const alerts = new AlertManager();
alerts.onAlert((alert) => {
  console.log(`[${alert.type}] ${alert.message}`);
});
alerts.checkSpending(sessionKeyHash, dailySpent, dailyLimit);

// Audit logger
const logger = new AuditLogger();
const logs = await logger.getLogs({ limit: 100, chain: 10004 });

// Compliance export
const exporter = new ComplianceExporter();
const csv = exporter.exportToCSV(logs);
const json = exporter.exportToJSON(logs);
```

## React Hooks

The SDK includes React hooks for building agent dashboards:

```tsx
import {
  AgentWalletProvider,
  useAgentWallet,
  useAgentWalletContext,
  usePayment,
  useSessionStatus,
  useFetchWithPayment,
  useCostEstimate,
  useProtocolDetection,
  useMultiChainBalance,
  usePaymentHistory,
  useSpendingAlerts,
  useCanPay,
} from '@veridex/agentic-payments';

function App() {
  return (
    <AgentWalletProvider config={walletConfig}>
      <Dashboard />
    </AgentWalletProvider>
  );
}

function Dashboard() {
  const wallet = useAgentWalletContext();
  const { pay, isPaying } = usePayment(wallet);
  const { status } = useSessionStatus(wallet);
  const { fetchWithPayment, data, isPending, detectedProtocol } = useFetchWithPayment(wallet);
  const { estimate } = useCostEstimate(wallet, 'https://api.example.com/premium');
  const { balances, totalUSD } = useMultiChainBalance(wallet);
  const { canPay, reason } = useCanPay(wallet, 5.00);

  return (
    <div>
      <p>Budget: ${status?.remainingDailyLimitUSD.toFixed(2)} remaining</p>
      <p>Portfolio: ${totalUSD.toFixed(2)}</p>
      <button onClick={() => fetchWithPayment('https://api.example.com/premium')}
        disabled={isPending || !canPay}>
        {isPending ? 'Paying...' : `Get Data`}
      </button>
    </div>
  );
}
```

## Error Handling

```typescript
import { AgentPaymentError, AgentPaymentErrorCode } from '@veridex/agentic-payments';

try {
  await agent.pay({
    chain: 10004,
    token: 'USDC',
    amount: '100000000', // 100 USDC
    recipient: '0x...',
  });
} catch (error) {
  if (error instanceof AgentPaymentError) {
    console.log(`Code: ${error.code}`);
    console.log(`Message: ${error.message}`);
    console.log(`Retryable: ${error.retryable}`);
    console.log(`Suggestion: ${error.suggestion}`);

    switch (error.code) {
      case AgentPaymentErrorCode.LIMIT_EXCEEDED:
        console.log('Over budget! Wait for daily reset.');
        break;
      case AgentPaymentErrorCode.INSUFFICIENT_BALANCE:
        console.log('Need more tokens.');
        break;
      case AgentPaymentErrorCode.SESSION_EXPIRED:
        // Re-initialize agent
        break;
      case AgentPaymentErrorCode.CHAIN_NOT_SUPPORTED:
        console.log('Chain not in allowedChains list.');
        break;
      case AgentPaymentErrorCode.TOKEN_NOT_SUPPORTED:
        console.log('Use USDC, ETH, or native.');
        break;
    }
  }
}
```

## Testing

```bash
npm run test        # 372 tests across 20 suites
npm run build       # Production build via tsup
```

## Architecture

Built on [`@veridex/sdk`](https://www.npmjs.com/package/@veridex/sdk) for core chain clients and passkey authentication. This package adds:

- **Session key management** with spending limits and encryption
- **Protocol abstraction layer** (x402, UCP, ACP, AP2, MPP) with auto-detection
- **PaymentIntent normalization** — protocol-agnostic payment representation
- **SettlementVerifier** — on-chain settlement confirmation
- **ProtocolRegistry** — capability-based protocol selection
- **Policy Engine** — 8 built-in rules, allow/deny/escalate verdicts
- **Security Firewall** — injection detection, tool sanitization, output scanning, anomaly detection
- **Trace & Evidence** — cryptographic audit trails with 8 storage backends
- **Escalation & Circuit Breaker** — human-in-the-loop approval, automatic halt on failures
- **Payment signing** for EVM (EIP-712) and non-EVM (Ed25519, secp256k1, Stark ECDSA)
- **ERC-8004 identity** — on-chain agent registration, reputation, trust gates, discovery
- **Cross-chain routing** with bridge orchestration and fee estimation
- **Hardened MCP server** for secure LLM tool integration
- **Express/Next.js middleware** for merchant-side paywalls
- **React hooks** for building agent dashboards

### Module Map

```
src/
├── AgentWallet.ts              — Central orchestrator
├── identity/                   — ERC-8004 Identity, Reputation, Trust, Discovery
├── protocols/
│   ├── base/                   — ProtocolHandler, ProtocolDetector, PaymentIntent,
│   │                             SettlementVerifier, ProtocolRegistry
│   ├── x402/                   — X402Handler (priority 70)
│   ├── ucp/                    — UCPHandler (priority 100)
│   ├── acp/                    — ACPHandler (priority 90)
│   ├── ap2/                    — AP2Handler (priority 80)
│   └── mpp/                    — MPPHandler (priority 85) — Tempo micropayments
├── policy/                     — PolicyEngine + 8 rules (spending, velocity, whitelist, etc.)
├── security/                   — InjectionDetector, ToolSanitizer, OutputGuard, AnomalyDetector
├── trace/                      — TraceInterceptor, EvidenceBundle
│   └── storage/                — 8 adapters (Memory, JSON, Postgres, IPFS, Arweave,
│                                 Filecoin, Storacha, Akave)
├── escalation/                 — EscalationManager, CircuitBreaker
├── session/                    — SessionKeyManager, SpendingTracker, SessionStorage
├── chains/                     — Per-chain clients (Base, Monad, Solana, Aptos, Stacks, etc.)
├── x402/                       — PaymentSigner, PaymentParser, NonEvmPaymentSigner
├── mcp/                        — Hardened MCPServer with security config
├── middleware/                  — veridexPaywall, createPaywallHandler
├── monitoring/                  — AuditLogger, AlertManager, ComplianceExporter, BalanceCache
├── oracle/                     — PythOracle (real-time price feeds)
├── routing/                    — CrossChainRouter, BridgeOrchestrator, DEXAggregator, FeeEstimator
└── react/                      — React hooks (useAgentWallet, useFetchWithPayment, etc.)
```

### ERC-8004 Canonical Addresses

The same singleton addresses work on **every EVM chain** (deployed via CREATE2):

| Registry | Mainnet | Testnet |
|----------|---------|---------|
| **Identity** | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| **Reputation** | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

Supported chains: Base, Ethereum, Polygon, Arbitrum, Optimism, Linea, MegaETH, Monad (+ all testnets).

## License

MIT — see [LICENSE](LICENSE)

## Links

- [Documentation](https://docs.veridex.network)
- [GitHub](https://github.com/Veridex-Protocol/agentic-payments)
- [npm](https://www.npmjs.com/package/@veridex/agentic-payments)
- [ERC-8004 Specification](https://www.8004.org/learn)
- [Discord](https://discord.gg/veridex)
- [Twitter](https://twitter.com/VeridexProtocol)
