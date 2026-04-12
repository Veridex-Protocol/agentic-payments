/**
 * @packageDocumentation
 * @module MCPServer
 * @description
 * Hardened Model Context Protocol (MCP) Server for AI Agent Tools.
 *
 * Security layers (Phase 5):
 * - Tool description sanitization via ToolSanitizer (strips hidden instructions)
 * - Tool description pinning for rug-pull detection
 * - Configurable allowedTools whitelist
 * - Per-tool spending limits
 * - Input injection detection via InjectionDetector
 * - Output secret scanning via OutputGuard
 * - Execution tracing via TraceInterceptor
 *
 * Exposed Tools:
 * - `veridex_create_session_key`: Initialize a new constrained wallet.
 * - `veridex_pay`: Execute a cross-chain transaction.
 * - `veridex_check_balance`: Query unified portfolio balance.
 * - `veridex_revoke_session`: Revoke agent wallet access.
 * - `veridex_get_payment_history`: Retrieve transaction history.
 */
import { AgentWallet } from '../AgentWallet';
import { MCPTool, MCPToolResult } from '../types/mcp';
import { ToolSanitizer } from '../security/ToolSanitizer';
import { InjectionDetector } from '../security/InjectionDetector';
import { OutputGuard } from '../security/OutputGuard';
import * as schemas from './schemas';

/** Configuration for the hardened MCP server */
export interface MCPServerConfig {
  /** Whitelist of allowed tool names. If set, only these tools are exposed. */
  allowedTools?: string[];
  /** Per-tool spending limits in USD. Key = tool name. */
  toolSpendingLimits?: Record<string, number>;
  /** Whether to sanitize tool descriptions (default: true) */
  sanitizeDescriptions?: boolean;
  /** Whether to pin tool descriptions for rug-pull detection (default: true) */
  pinDescriptions?: boolean;
  /** Whether to scan inputs for injection (default: true) */
  scanInputs?: boolean;
  /** Whether to scan outputs for secrets (default: true) */
  scanOutputs?: boolean;
}

export class MCPServer {
  private readonly injectionDetector: InjectionDetector;
  private readonly outputGuard: OutputGuard;
  private readonly toolSanitizer: ToolSanitizer;
  private readonly config: Required<MCPServerConfig>;
  private pinned = false;
  private toolSpent = new Map<string, number>();

  constructor(
    private agentWallet: AgentWallet,
    config?: MCPServerConfig,
  ) {
    this.injectionDetector = new InjectionDetector();
    this.outputGuard = new OutputGuard();
    this.toolSanitizer = new ToolSanitizer(this.injectionDetector);
    this.config = {
      allowedTools: config?.allowedTools ?? [],
      toolSpendingLimits: config?.toolSpendingLimits ?? {},
      sanitizeDescriptions: config?.sanitizeDescriptions ?? true,
      pinDescriptions: config?.pinDescriptions ?? true,
      scanInputs: config?.scanInputs ?? true,
      scanOutputs: config?.scanOutputs ?? true,
    };
  }

  getTools(): MCPTool[] {
    const allTools: MCPTool[] = [
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
        handler: (params) => this.agentWallet.revokeSession(String(params.sessionKeyHash)),
      },
      {
        name: 'veridex_get_payment_history',
        description: 'Retrieve transaction history',
        inputSchema: schemas.GET_HISTORY_SCHEMA,
        handler: (params) => this.agentWallet.getPaymentHistory(params),
      },
      {
        name: 'veridex_pause_session',
        description: 'Pause the agent wallet session. Transactions are blocked until resumed. Reversible.',
        inputSchema: schemas.PAUSE_SESSION_SCHEMA,
        handler: (params) => this.agentWallet.pauseSession(
          params.sessionKeyHash ? String(params.sessionKeyHash) : undefined,
          params.reason ? String(params.reason) : undefined,
        ),
      },
      {
        name: 'veridex_resume_session',
        description: 'Resume a paused agent wallet session. Re-enables transactions.',
        inputSchema: schemas.RESUME_SESSION_SCHEMA,
        handler: (params) => this.agentWallet.resumeSession(
          params.sessionKeyHash ? String(params.sessionKeyHash) : undefined,
        ),
      },
    ];

    // Apply whitelist filter
    let tools = this.config.allowedTools.length > 0
      ? allTools.filter((t) => this.config.allowedTools.includes(t.name))
      : allTools;

    // Sanitize descriptions
    if (this.config.sanitizeDescriptions) {
      tools = tools.map((tool) => {
        const result = this.toolSanitizer.sanitizeToolDescription({
          name: tool.name,
          description: tool.description,
          server: 'veridex',
        });
        return { ...tool, description: result.sanitized.description };
      });
    }

    // Pin on first call
    if (this.config.pinDescriptions && !this.pinned) {
      this.toolSanitizer.pinToolDescriptions(
        tools.map((t) => ({ name: t.name, description: t.description, server: 'veridex' })),
      );
      this.pinned = true;
    }

    return tools;
  }

  async executeTool(toolName: string, params: Record<string, unknown>): Promise<MCPToolResult> {
    // Whitelist check
    if (
      this.config.allowedTools.length > 0 &&
      !this.config.allowedTools.includes(toolName)
    ) {
      return {
        content: [{ type: 'text', text: `Error: Tool "${toolName}" is not in the allowed list` }],
        isError: true,
      };
    }

    const tool = this.getTools().find((t) => t.name === toolName);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Error: Tool "${toolName}" not found` }],
        isError: true,
      };
    }

    // Pin validation (detect description rug-pulls)
    if (this.config.pinDescriptions) {
      const pinResult = this.toolSanitizer.validateToolPin({
        name: tool.name,
        description: tool.description,
        server: 'veridex',
      });
      if (!pinResult.valid) {
        return {
          content: [{ type: 'text', text: `Security: Tool description changed since pinning — ${pinResult.reason}` }],
          isError: true,
        };
      }
    }

    // Input injection scanning
    if (this.config.scanInputs) {
      const serialized = JSON.stringify(params);
      const injection = this.injectionDetector.detect(serialized);
      if (injection.detected) {
        const categories = injection.matches.map((m) => m.category).join(', ');
        return {
          content: [{ type: 'text', text: `Security: Injection detected in tool input — categories: ${categories}` }],
          isError: true,
        };
      }
    }

    // Per-tool spending limit check
    const spendingLimit = this.config.toolSpendingLimits[toolName];
    if (spendingLimit !== undefined) {
      const spent = this.toolSpent.get(toolName) ?? 0;
      if (spent >= spendingLimit) {
        return {
          content: [{ type: 'text', text: `Limit: Tool "${toolName}" has exceeded its spending limit ($${spent.toFixed(2)}/$${spendingLimit.toFixed(2)})` }],
          isError: true,
        };
      }
    }

    try {
      const result = await tool.handler(params);
      const resultText = JSON.stringify(result, null, 2);

      // Output secret scanning
      if (this.config.scanOutputs) {
        const secretScan = this.outputGuard.scanForSecrets(resultText);
        if (secretScan.found) {
          const types = secretScan.matches.map((m) => m.type).join(', ');
          return {
            content: [{ type: 'text', text: `Security: Secrets detected in tool output (${types}). Output suppressed.` }],
            isError: true,
          };
        }
      }

      // Track spending for pay tool
      if (toolName === 'veridex_pay' && params.amountUSD !== undefined) {
        const current = this.toolSpent.get(toolName) ?? 0;
        this.toolSpent.set(toolName, current + (params.amountUSD as number));
      }

      return {
        content: [{ type: 'text', text: resultText }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      // Scan error messages for secrets too
      if (this.config.scanOutputs) {
        const secretScan = this.outputGuard.scanForSecrets(message);
        if (secretScan.found) {
          return {
            content: [{ type: 'text', text: 'Error: An error occurred (details redacted for security)' }],
            isError: true,
          };
        }
      }

      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Reset per-tool spending counters. Call at the start of a new session.
   */
  resetSpendingCounters(): void {
    this.toolSpent.clear();
  }

  /**
   * Get current spending for a tool.
   */
  getToolSpending(toolName: string): number {
    return this.toolSpent.get(toolName) ?? 0;
  }
}
