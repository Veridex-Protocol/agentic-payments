/**
 * Example: Basic Agent Wallet Usage
 * 
 * This example demonstrates the core functionality of the Veridex
 * Agentic Payments SDK for autonomous AI agent payments.
 */

import { createAgentWallet, AgentWalletConfig, AgentPaymentError } from '../src';

async function main() {
  // In a real application, you would get the PasskeyCredential from
  // the @veridex/sdk after user authentication:
  // 
  //   const sdk = createSDK('base');
  //   const credential = await sdk.passkey.register('alice', 'My Agent Wallet');
  //
  // For this example, we use a placeholder credential
  const masterCredential = {
    credentialId: 'example-credential-id-12345',
    publicKeyX: BigInt('0x' + '1'.repeat(64)), // Placeholder
    publicKeyY: BigInt('0x' + '2'.repeat(64)), // Placeholder
    keyHash: '0x' + 'a'.repeat(64), // Placeholder
  };

  // 1. Configure the agent wallet with bounded session limits
  const config: AgentWalletConfig = {
    masterCredential,
    session: {
      dailyLimitUSD: 100,       // Agent can spend up to $100/day
      perTransactionLimitUSD: 25, // Max $25 per transaction
      expiryHours: 8,           // Session expires after 8 hours
      allowedChains: [30, 23],  // Base and Arbitrum (Wormhole chain IDs)
    },
    relayerUrl: 'https://relayer.veridex.network',
    relayerApiKey: process.env.VERIDEX_API_KEY,
  };

  try {
    // 2. Initialize the agent wallet
    const agent = await createAgentWallet(config);
    console.log('✅ Agent wallet initialized');

    // 3. Check session status
    const status = agent.getSessionStatus();
    console.log('\n📊 Session Status:');
    console.log(`   Valid: ${status.isValid}`);
    console.log(`   Key Hash: ${status.keyHash.slice(0, 18)}...`);
    console.log(`   Expires: ${new Date(status.expiry).toISOString()}`);
    console.log(`   Daily Limit Remaining: $${status.remainingDailyLimitUSD}`);

    // 4. Make an autonomous payment using HTTP 402 handling
    // When the agent fetches a paywalled resource, it automatically:
    // - Detects the 402 Payment Required response
    // - Parses payment requirements
    // - Signs an ERC-3009 authorization
    // - Retries the request with payment proof
    console.log('\n🔄 Fetching paywalled resource...');
    try {
      const response = await agent.fetch('https://api.example.com/premium-data');
      if (response.ok) {
        const data = await response.json();
        console.log('✅ Successfully accessed premium data:', data);
      }
    } catch (error) {
      if (error instanceof AgentPaymentError) {
        console.log(`⚠️ Payment handling: ${error.message}`);
        console.log(`   Remediation: ${error.remediation}`);
      }
    }

    // 5. Make an explicit payment (e.g., for purchasing an item)
    console.log('\n💳 Making explicit payment...');
    try {
      const receipt = await agent.pay({
        amount: '5.00',
        token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        recipient: '0x0000000000000000000000000000000000000001',
        chain: 30, // Base
        protocol: 'direct',
      });
      console.log('✅ Payment complete');
      console.log(`   TxHash: ${receipt.txHash}`);
      console.log(`   Amount: ${receipt.amount.toString()}`);
      console.log(`   Status: ${receipt.status}`);
    } catch (error) {
      if (error instanceof AgentPaymentError) {
        console.log(`❌ Payment failed: ${error.message}`);
      }
    }

    // 6. Check balances across chains
    console.log('\n💰 Checking balances...');
    const balances = await agent.getBalance(30); // Base chain
    for (const token of balances) {
      console.log(`   ${token.token.symbol}: ${token.formatted} (${token.token.address})`);
    }

    // 7. Get payment history
    console.log('\n📜 Payment History:');
    const history = await agent.getPaymentHistory({ limit: 5 });
    for (const record of history) {
      console.log(`   ${new Date(record.timestamp).toLocaleDateString()}: ${record.status} - ${record.amount}`);
    }

    // 8. Set up spending alerts
    agent.onSpendingAlert((alert) => {
      console.log(`\n🚨 SPENDING ALERT: ${alert.message}`);
      console.log(`   Daily spent: $${alert.dailySpentUSD} / $${alert.dailyLimitUSD}`);
    });

    // 9. Export audit log for compliance
    const auditLog = await agent.exportAuditLog('json');
    console.log('\n📋 Audit log exported:', auditLog.length, 'bytes');

    // 10. Revoke session when done
    console.log('\n🔒 Revoking session...');
    await agent.revokeSession();
    console.log('✅ Session revoked');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
