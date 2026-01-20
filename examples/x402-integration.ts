/**
 * Example: x402 Protocol Integration
 * 
 * This example demonstrates how the AgentWallet automatically handles
 * HTTP 402 "Payment Required" responses from paywalled APIs.
 */

import { createAgentWallet, AgentWalletConfig, AgentPaymentError } from '../src';

async function main() {
    // Configure the agent wallet
    const config: AgentWalletConfig = {
        masterCredential: {
            credentialId: 'example-credential-id',
            publicKeyX: BigInt('0x1234...'),
            publicKeyY: BigInt('0x5678...'),
            keyHash: '0xabcdef...'
        },
        session: {
            dailyLimitUSD: 50,
            perTransactionLimitUSD: 5,
            expiryHours: 8,
            allowedChains: [30, 23] // Base and Arbitrum
        },
        relayerUrl: 'https://relayer.veridex.network',
        relayerApiKey: process.env.VERIDEX_API_KEY
    };

    const agent = await createAgentWallet(config);
    console.log('Agent initialized with session:', agent.getSessionStatus());

    // The agent.fetch() method wraps standard fetch
    // When it receives a 402 response, it automatically:
    // 1. Parses the payment requirements from headers
    // 2. Checks session spending limits
    // 3. Signs a payment authorization (ERC-3009)
    // 4. Retries the request with the payment proof

    try {
        // Access a paywalled API endpoint
        const response = await agent.fetch('https://api.premium-data.com/v1/market-analysis');

        if (response.ok) {
            const data = await response.json();
            console.log('Successfully accessed premium data:', data);
        }
    } catch (error) {
        if (error instanceof AgentPaymentError) {
            console.error(`Payment failed [${error.code}]: ${error.message}`);
            console.log('Remediation:', error.remediation);

            if (error.retryable) {
                console.log('This error is retryable. Consider trying again.');
            }
        } else {
            throw error;
        }
    }

    // Check remaining limits
    const status = agent.getSessionStatus();
    console.log(`Remaining daily limit: $${status.remainingDailyLimitUSD}`);

    // Set up spending alerts
    agent.onSpendingAlert((alert) => {
        console.warn(`⚠️ Spending Alert: ${alert.message}`);
        console.warn(`   Daily spent: $${alert.dailySpentUSD} / $${alert.dailyLimitUSD}`);
    });

    // Export audit log for compliance
    const auditLog = await agent.exportAuditLog('json');
    console.log('Audit log:', auditLog);
}

main().catch(console.error);
