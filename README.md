# @veridex/agentic-payments

[![npm version](https://img.shields.io/npm/v/@veridex/agentic-payments.svg)](https://www.npmjs.com/package/@veridex/agentic-payments)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A comprehensive SDK for autonomous agent payments, built on top of `@veridex/sdk`. This package provides session key management, x402 protocol support, UCP credential provider, MCP server integration, and multi-chain payment routing.

## Features

- **Session Key Management**: Secure, time-limited signing keys with spending limits
- **x402 Protocol**: Automatic HTTP 402 payment handling
- **UCP Integration**: Universal Credential Protocol support for payment tokenization
- **MCP Server**: Model Context Protocol server for LLM integration
- **Multi-Chain Support**: EVM, Solana, Aptos, Sui, and Starknet
- **Real-Time Pricing**: Pyth Network oracle integration
- **Performance Optimizations**: Client-side nonce tracking, transaction batching, confirmation polling

## Installation

```bash
npm install @veridex/agentic-payments
# or
yarn add @veridex/agentic-payments
# or
pnpm add @veridex/agentic-payments
```

## Quick Start

### Basic Agent Setup

```typescript
import { createAgentWallet, AgentWalletConfig } from '@veridex/agentic-payments';

const config: AgentWalletConfig = {
  masterCredential: {
    credentialId: 'your-passkey-credential-id',
    publicKeyX: BigInt('...'),
    publicKeyY: BigInt('...'),
    keyHash: '0x...',
  },
  session: {
    dailyLimitUSD: 100,
    perTransactionLimitUSD: 25,
    expiryHours: 8,
    allowedChains: [30], // Base
  },
  relayerUrl: 'https://relay.veridex.network',
};

const agent = await createAgentWallet(config);
```

### Making Payments

```typescript
// Direct payment
const receipt = await agent.pay({
  amount: '10.00',
  token: 'USDC',
  recipient: '0x...',
  chain: 30,
});

// Automatic 402 payment handling
const response = await agent.fetch('https://api.paid-service.com/resource');
```

### Session Management

```typescript
// Check session status
const status = agent.getSessionStatus();
console.log(`Remaining limit: $${status.remainingDailyLimitUSD}`);

// Revoke session
await agent.revokeSession();
```

## Core Modules

### Session Key Manager

Manages the lifecycle of session keys with spending limits and encryption.

```typescript
import { SessionKeyManager } from '@veridex/agentic-payments';

const manager = new SessionKeyManager();

// Create a session
const session = await manager.createSession(masterKey, {
  dailyLimitUSD: 100,
  perTransactionLimitUSD: 25,
  expiryTimestamp: Date.now() + 8 * 60 * 60 * 1000, // 8 hours
  allowedChains: [30],
});

// Check limits before payment
const result = manager.checkLimits(session, 20);
if (result.allowed) {
  // Execute payment
  await manager.recordSpending(session, 20);
}

// Revoke session
await manager.revokeSession(session.keyHash);
```

### x402 Protocol Client

Handles HTTP 402 Payment Required responses automatically.

```typescript
import { X402Client } from '@veridex/agentic-payments';

const client = new X402Client({
  sessionManager,
  session,
  relayerUrl: 'https://relay.veridex.network',
});

// Automatic payment on 402 response
const response = await client.fetch('https://paid-api.example.com/data');
```

### UCP Credential Provider

Universal Credential Protocol support for payment tokenization.

```typescript
import { UCPCredentialProvider, PaymentTokenizer } from '@veridex/agentic-payments';

// Generate payment tokens
const tokenizer = new PaymentTokenizer();
const token = await tokenizer.tokenize(session);

// Validate tokens
const validation = tokenizer.validate(token.token);
if (validation.valid) {
  // Process payment
}

// Revoke tokens
tokenizer.revokeAllForSession(session.keyHash);
```

### MCP Server Integration

Run a Model Context Protocol server for LLM integration.

```typescript
import { MCPServer } from '@veridex/agentic-payments';

const server = new MCPServer({
  wallet: agent,
  port: 3000,
  allowedOrigins: ['https://claude.ai'],
});

await server.start();

// Available tools:
// - veridex_create_session_key
// - veridex_pay
// - veridex_check_balance
// - veridex_revoke_session
// - veridex_get_payment_history
```

### Multi-Chain Clients

Support for multiple blockchains with unified interface.

```typescript
import { ChainClientFactory } from '@veridex/agentic-payments';

// Create clients for different chains
const baseClient = ChainClientFactory.createClient('base', 'mainnet');
const solanaClient = ChainClientFactory.createClient('solana', 'mainnet');
const aptosClient = ChainClientFactory.createClient('aptos', 'mainnet');

// Get native token prices (via Pyth oracle)
const ethPrice = await baseClient.getNativeTokenPriceUSD();
const solPrice = await solanaClient.getNativeTokenPriceUSD();
```

### Monitoring & Alerts

Comprehensive monitoring for spending alerts and audit logging.

```typescript
import { AlertManager, AuditLogger } from '@veridex/agentic-payments';

// Alert manager with custom thresholds
const alerts = new AlertManager({
  spendingThresholds: [0.5, 0.8, 0.9, 1.0],
  highValueThresholdUSD: 1000,
  anomalyDetectionEnabled: true,
  webhookUrl: 'https://your-webhook.com/alerts',
});

alerts.onAlert((alert) => {
  console.log(`Alert: ${alert.type} - ${alert.message}`);
});

// High-value transaction approval
if (alerts.isHighValueTransaction(1500)) {
  const approval = alerts.requestApproval('tx-123', 1500);
  // Wait for master key approval
  alerts.approveTransaction('tx-123', masterKeyHash);
}

// Audit logging
const logger = new AuditLogger();
await logger.log(paymentReceipt, session.keyHash);

// Export logs
const logs = await logger.getLogs({ limit: 100 });
```

### Performance Optimizations

Tools for optimizing transaction throughput and confirmation tracking.

```typescript
import { 
  NonceManager, 
  TransactionQueue, 
  TransactionPoller 
} from '@veridex/agentic-payments';

// Client-side nonce tracking
const nonces = new NonceManager();
const nextNonce = nonces.getNextNonce(keyHash);
nonces.reserveNonce(keyHash, nextNonce);

// Transaction batching
const queue = new TransactionQueue({ batchSize: 10, batchDelayMs: 100 });
queue.enqueue({
  keyHash,
  payload: { recipient, amount, token, chain },
  priority: 'high',
});
await queue.flush();

// Confirmation polling
const poller = new TransactionPoller(async (txHash, chain) => {
  // Check confirmation status
  return { confirmed: true, confirmations: 1, blockNumber: 12345 };
});
poller.track(txHash, chain, (event) => {
  console.log(`Transaction ${event.txHash} confirmed!`);
});
```

## React Hooks

Use the SDK in React applications with built-in hooks.

```typescript
import { 
  useAgentWallet, 
  usePaymentHistory, 
  useSessionStatus 
} from '@veridex/agentic-payments';

function PaymentComponent() {
  const { wallet, isLoading, error } = useAgentWallet(config);
  const { history } = usePaymentHistory(wallet);
  const { status } = useSessionStatus(wallet);

  return (
    <div>
      <p>Remaining limit: ${status?.remainingDailyLimitUSD}</p>
      <button onClick={() => wallet?.pay(paymentParams)}>
        Pay
      </button>
    </div>
  );
}
```

## Error Handling

The SDK provides structured errors with remediation suggestions.

```typescript
import { 
  AgentPaymentError, 
  AgentPaymentErrorCode 
} from '@veridex/agentic-payments';

try {
  await agent.pay(params);
} catch (error) {
  if (error instanceof AgentPaymentError) {
    console.log(`Error code: ${error.code}`);
    console.log(`Message: ${error.message}`);
    console.log(`Remediation: ${error.remediation}`);
    console.log(`Retryable: ${error.retryable}`);
  }
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `SESSION_EXPIRED` | Session has expired |
| `SESSION_INVALID` | Session configuration is invalid |
| `LIMIT_EXCEEDED_DAILY` | Daily spending limit exceeded |
| `LIMIT_EXCEEDED_PER_TX` | Per-transaction limit exceeded |
| `CHAIN_NOT_SUPPORTED` | Chain not in allowed chains list |
| `PAYMENT_FAILED` | Payment transaction failed |
| `SIGNATURE_INVALID` | Invalid signature |
| `NETWORK_ERROR` | Network communication error |

## Configuration

### Environment Variables

```env
# Optional relayer configuration
VERIDEX_RELAYER_URL=https://relay.veridex.network
VERIDEX_RELAYER_API_KEY=your-api-key

# Optional MCP server
MCP_PORT=3000
MCP_ALLOWED_ORIGINS=https://claude.ai,https://your-app.com
```

### TypeScript Configuration

The SDK is fully typed. Import types as needed:

```typescript
import type {
  AgentWalletConfig,
  PaymentParams,
  PaymentReceipt,
  SessionStatus,
  SpendingAlert,
} from '@veridex/agentic-payments';
```

## API Reference

Full API documentation is available at [docs.veridex.network](https://docs.veridex.network).

## Examples

See the `examples/` directory for complete usage examples:

- `basic-agent.ts` - Basic agent setup and payments
- `x402-integration.ts` - x402 protocol integration
- `ucp-checkout.ts` - UCP checkout flow
- `mcp-claude.ts` - MCP server for Claude integration

## Testing

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Run specific test file
npm run test -- session.test.ts
```

## Building

```bash
# Build for production
npm run build

# Development mode
npm run dev
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

## Support

- [Documentation](https://docs.veridex.network)
- [Discord](https://discord.gg/veridex)
- [GitHub Issues](https://github.com/veridex/agent-sdk/issues)
