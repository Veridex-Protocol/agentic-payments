/**
 * Example: UCP Checkout Flow
 * 
 * This example demonstrates how to use the UCP Credential Provider
 * for processing checkout requests from merchants.
 */

import { createAgentWallet, AgentWalletConfig, UCPCredentialProvider } from '../src';

async function main() {
    const config: AgentWalletConfig = {
        masterCredential: {
            credentialId: 'ucp-credential',
            publicKeyX: BigInt('0x...'),
            publicKeyY: BigInt('0x...'),
            keyHash: '0x...'
        },
        session: {
            dailyLimitUSD: 200,
            perTransactionLimitUSD: 50,
            expiryHours: 12,
            allowedChains: [30, 1] // Base and Ethereum
        },
        // Enable UCP
        ucp: {
            enabled: true,
            merchantId: 'my-merchant-123',
            callbackUrl: 'https://myapp.com/ucp/callback'
        },
        relayerUrl: 'https://relayer.veridex.network'
    };

    const agent = await createAgentWallet(config);
    console.log('Agent wallet ready for UCP checkout');

    // Simulate a UCP checkout request from a merchant
    // In a real scenario, this would come from the merchant's API
    const checkoutRequest = {
        platformId: 'veridex-agent',
        businessId: 'merchant-xyz',
        amount: '19.99',
        currency: 'USD',
        items: [
            {
                name: 'Premium API Access',
                quantity: 1,
                unitPrice: '19.99',
                currency: 'USD'
            }
        ],
        metadata: {
            orderId: 'order-12345',
            description: 'Monthly API subscription'
        }
    };

    console.log('Processing checkout request:', checkoutRequest);

    // The UCP flow:
    // 1. Merchant sends checkout request
    // 2. Agent validates limits
    // 3. Agent tokenizes payment instrument
    // 4. Agent returns checkout response with payment token
    // 5. Merchant completes settlement via Veridex relayer

    try {
        // Using the fetch method which handles UCP automatically
        const response = await agent.fetch('https://api.merchant.com/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(checkoutRequest)
        });

        if (response.ok) {
            const result = await response.json();
            console.log('Checkout completed!');
            console.log('Transaction hash:', result.txHash);
            console.log('Order ID:', result.orderId);
        }
    } catch (error) {
        console.error('Checkout failed:', error);
    }

    // Check session status after checkout
    const status = agent.getSessionStatus();
    console.log('\nSession Status:');
    console.log(`  Valid: ${status.isValid}`);
    console.log(`  Remaining daily limit: $${status.remainingDailyLimitUSD}`);
    console.log(`  Total spent: $${status.totalSpentUSD}`);
}

main().catch(console.error);
