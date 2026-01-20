/**
 * Example: MCP Integration with Claude
 * 
 * This example shows how to expose the AgentWallet as MCP tools
 * that can be invoked by LLMs like Claude.
 */

import { createAgentWallet, AgentWalletConfig } from '../src';

async function main() {
    const config: AgentWalletConfig = {
        masterCredential: {
            credentialId: 'mcp-agent-credential',
            publicKeyX: BigInt('0x...'),
            publicKeyY: BigInt('0x...'),
            keyHash: '0x...'
        },
        session: {
            dailyLimitUSD: 100,
            perTransactionLimitUSD: 25,
            expiryHours: 24,
            allowedChains: [30] // Base
        },
        // Enable MCP server
        mcp: {
            enabled: true,
            port: 3000,
            allowedOrigins: ['https://claude.ai']
        },
        relayerUrl: 'https://relayer.veridex.network'
    };

    const agent = await createAgentWallet(config);

    // Get the MCP tools that can be exposed to an LLM
    const tools = agent.getMCPTools();

    console.log('Available MCP Tools:');
    tools.forEach(tool => {
        console.log(`  - ${tool.name}: ${tool.description}`);
    });

    // Example: How Claude would invoke the veridex_pay tool
    // In a real MCP setup, this would be called by the LLM runtime
    const payTool = tools.find(t => t.name === 'veridex_pay');
    if (payTool) {
        try {
            const result = await payTool.handler({
                amount: '5.00',
                token: 'USDC',
                recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f9f0E3',
                chain: 30
            });
            console.log('Payment result:', result);
        } catch (error) {
            console.error('Payment failed:', error);
        }
    }

    // Check balance using MCP tool
    const balanceTool = tools.find(t => t.name === 'veridex_check_balance');
    if (balanceTool) {
        const balances = await balanceTool.handler({ chain: 30 });
        console.log('Balances:', balances);
    }

    // Get payment history
    const historyTool = tools.find(t => t.name === 'veridex_get_payment_history');
    if (historyTool) {
        const history = await historyTool.handler({ limit: 10 });
        console.log('Recent transactions:', history);
    }
}

main().catch(console.error);
