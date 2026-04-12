# Migration Guide: @veridex/sdk to @veridex/agentic-payments

This guide helps you migrate from using `@veridex/sdk` directly to using `@veridex/agentic-payments` for agent-based payment workflows.

## Overview

`@veridex/agentic-payments` is built on top of `@veridex/sdk` and provides:
- **Session key management** with spending limits
- **Automatic x402 payment handling**
- **UCP credential provider** for payment tokenization
- **MCP server** for LLM integration
- **Multi-chain support** with unified interface

## Installation

```bash
# Remove direct @veridex/sdk usage (if only used for payments)
npm uninstall @veridex/sdk

# Install the agentic payments SDK
npm install @veridex/agentic-payments
```

> Note: `@veridex/agentic-payments` includes `@veridex/sdk` as a dependency, so you still have access to core SDK features.

## Key Differences

| Feature | @veridex/sdk | @veridex/agentic-payments |
|---------|-------------|---------------------------|
| Authentication | Direct passkey | Session keys with limits |
| Payments | Manual signing | Automatic with retry |
| Multi-chain | Chain-specific clients | Unified interface |
| x402 | Manual handling | Automatic interception |
| Monitoring | None | Audit logging, alerts |

## Migration Steps

### 1. Replace Direct Wallet Usage

**Before (with @veridex/sdk):**

```typescript
import { VeridexSDK } from '@veridex/sdk';

const sdk = await VeridexSDK.create({
  chainPreset: 'base',
  networkType: 'mainnet',
});

// Direct signing with master key
const tx = await sdk.hub.executePayment({
  recipient: '0x...',
  amount: '10000000', // 10 USDC
  token: '0x...',
});
```

**After (with @veridex/agentic-payments):**

```typescript
import { createAgentWallet } from '@veridex/agentic-payments';

const agent = await createAgentWallet({
  masterCredential: {
    credentialId: 'your-passkey-credential',
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
});

// Payment with automatic limit checking
const receipt = await agent.pay({
  recipient: '0x...',
  amount: '10.00',
  token: 'USDC',
  chain: 30,
});
```

### 2. Replace Manual x402 Handling

**Before:**

```typescript
async function fetchWithPayment(url: string) {
  let response = await fetch(url);
  
  if (response.status === 402) {
    const paymentHeader = response.headers.get('X-Payment-Required');
    const parsed = JSON.parse(atob(paymentHeader));
    
    // Manual payment logic
    const tx = await sdk.hub.executePayment({
      recipient: parsed.recipient,
      amount: parsed.amount,
      token: parsed.token,
    });
    
    // Retry with proof
    response = await fetch(url, {
      headers: {
        'X-Payment-Proof': tx.hash,
      },
    });
  }
  
  return response;
}
```

**After:**

```typescript
// Automatic handling built-in
const response = await agent.fetch('https://api.paid-service.com/resource');
// Payment automatically handled on 402 response
```

### 3. Replace Chain-Specific Clients

**Before:**

```typescript
import { EVMClient } from '@veridex/sdk/chains/evm';
import { SolanaClient } from '@veridex/sdk/chains/solana';

const evmClient = new EVMClient({ /* config */ });
const solanaClient = new SolanaClient({ /* config */ });

// Different APIs for each chain
const evmBalance = await evmClient.getBalance();
const solBalance = await solanaClient.getBalance();
```

**After:**

```typescript
import { ChainClientFactory } from '@veridex/agentic-payments';

// Unified interface
const baseClient = ChainClientFactory.createClient('base', 'mainnet');
const solanaClient = ChainClientFactory.createClient('solana', 'mainnet');

// Same API for all chains
const baseBalance = await baseClient.getBalance(address);
const solBalance = await solanaClient.getBalance(address);

// Or use multi-chain balance
const allBalances = await agent.getMultiChainBalance();
```

### 4. Add Session Management

Sessions are a new concept in `@veridex/agentic-payments`:

```typescript
// Check session status
const status = agent.getSessionStatus();
console.log(`Remaining: $${status.remainingDailyLimitUSD}`);
console.log(`Expires: ${new Date(status.expiresAt)}`);

// Revoke session (requires master key)
await agent.revokeSession();
```

### 5. Add Monitoring

**New features not available in @veridex/sdk:**

```typescript
// Subscribe to spending alerts
agent.onSpendingAlert((alert) => {
  console.log(`Alert: ${alert.type} - ${alert.message}`);
});

// Get payment history
const history = await agent.getPaymentHistory({
  limit: 50,
  chain: 30,
});

// Export audit logs
const csv = await agent.exportAuditLog('csv');
```

## React Migration

### Before (manual state management):

```typescript
import { useState, useEffect } from 'react';
import { VeridexSDK } from '@veridex/sdk';

function PaymentComponent() {
  const [sdk, setSdk] = useState(null);
  
  useEffect(() => {
    VeridexSDK.create(config).then(setSdk);
  }, []);
  
  // Manual state management...
}
```

### After (with hooks):

```typescript
import { useAgentWallet, useSessionStatus, usePaymentHistory } from '@veridex/agentic-payments';

function PaymentComponent() {
  const { wallet, isLoading, error } = useAgentWallet(config);
  const { status } = useSessionStatus(wallet);
  const { history } = usePaymentHistory(wallet);
  
  return (
    <div>
      <p>Remaining: ${status?.remainingDailyLimitUSD}</p>
      <button onClick={() => wallet?.pay(params)}>Pay</button>
    </div>
  );
}
```

## API Changes Summary

### Imports

```typescript
// Before
import { VeridexSDK, EVMClient } from '@veridex/sdk';

// After
import { 
  createAgentWallet,
  ChainClientFactory,
  SessionKeyManager,
  X402Client,
} from '@veridex/agentic-payments';
```

### Payment Parameters

```typescript
// Before
await sdk.hub.executePayment({
  recipient: '0x...',
  amount: '10000000',  // Raw units
  token: '0x...',      // Address
});

// After
await agent.pay({
  recipient: '0x...',
  amount: '10.00',     // Human-readable
  token: 'USDC',       // Symbol
  chain: 30,           // Chain ID
});
```

### Error Handling

```typescript
// Before - generic errors
try {
  await sdk.hub.executePayment(params);
} catch (error) {
  console.error(error.message);
}

// After - structured errors with remediation
import { AgentPaymentError } from '@veridex/agentic-payments';

try {
  await agent.pay(params);
} catch (error) {
  if (error instanceof AgentPaymentError) {
    console.log(`Code: ${error.code}`);
    console.log(`Fix: ${error.remediation}`);
    console.log(`Retryable: ${error.retryable}`);
  }
}
```

## Accessing Core SDK

If you need access to the underlying SDK for advanced use cases:

```typescript
// The core SDK is re-exported
import { VeridexSDK, EVMClient } from '@veridex/agentic-payments';

// Or access via the agent wallet
const coreClient = agent.getChainClient(30);
```

## Need Help?

- [Full API Documentation](https://docs.veridex.network/agentic-payments)
- [GitHub Issues](https://github.com/veridex/agent-payments/issues)
- [Discord Community](https://discord.gg/veridex)
