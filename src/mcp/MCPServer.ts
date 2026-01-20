import { AgentWallet } from '../AgentWallet';
import { MCPTool, MCPToolResult } from '../types/mcp';
import * as schemas from './schemas';

export class MCPServer {
  constructor(private agentWallet: AgentWallet) { }

  getTools(): MCPTool[] {
    return [
      {
        name: 'veridex_create_session_key',
        description: 'Create a bounded wallet for an AI agent',
        inputSchema: schemas.CREATE_SESSION_SCHEMA,
        handler: (params) => this.agentWallet.createSession(params),
      },
      {
        name: 'veridex_pay',
        description: 'Execute a payment across chains',
        inputSchema: schemas.PAY_SCHEMA,
        handler: (params) => this.agentWallet.pay(params),
      },
      {
        name: 'veridex_check_balance',
        description: 'Query wallet balances across all chains',
        inputSchema: schemas.CHECK_BALANCE_SCHEMA,
        handler: (params) => this.agentWallet.getBalance(params.chain),
      },
      {
        name: 'veridex_revoke_session',
        description: 'Revoke agent wallet access',
        inputSchema: schemas.REVOKE_SESSION_SCHEMA,
        handler: () => this.agentWallet.revokeSession(),
      },
      {
        name: 'veridex_get_payment_history',
        description: 'Retrieve transaction history',
        inputSchema: schemas.GET_HISTORY_SCHEMA,
        handler: (params) => this.agentWallet.getPaymentHistory(params),
      },
    ];
  }

  async executeTool(toolName: string, params: any): Promise<MCPToolResult> {
    const tool = this.getTools().find(t => t.name === toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    try {
      const result = await tool.handler(params);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
}
