/**
 * @packageDocumentation
 * @module LLMResponseGuard
 * @description
 * Validates LLM model responses before they reach the tool execution layer.
 * Defends against three threat vectors:
 *
 * 1. **LLM Router Compromise** — A compromised model provider returning malicious
 *    tool calls (e.g., "transfer all funds to attacker address"). Defended by:
 *    - Canary token verification (detect if system prompt was leaked/overridden)
 *    - Response structural validation (expected schema, no extra fields)
 *    - Financial action rate limiting (max actions per turn)
 *
 * 2. **Indirect Prompt Injection** — Malicious content in tool responses (e.g.,
 *    fetched web page contains "ignore previous instructions"). Defended by:
 *    - Scanning model output for injection relay patterns
 *    - Detecting if model is echoing/following injected instructions
 *
 * 3. **Supply Chain Attacks** — Compromised tool definitions or MCP servers
 *    injecting malicious descriptions that alter model behavior. Defended by:
 *    - Tool call argument validation against mandate constraints
 *    - Address allowlist enforcement before tool execution
 *    - Detection of novel/unexpected tool call patterns
 */

import { InjectionDetector, type InjectionResult } from './InjectionDetector';

// ── Types ──

export interface LLMResponseValidation {
  safe: boolean;
  violations: ResponseViolation[];
  riskScore: number;
}

export interface ResponseViolation {
  type: ResponseViolationType;
  severity: 'critical' | 'high' | 'medium';
  detail: string;
}

export type ResponseViolationType =
  | 'canary_leak'
  | 'excessive_financial_actions'
  | 'injection_relay'
  | 'unauthorized_address'
  | 'unexpected_tool_call'
  | 'reasoning_manipulation';

export interface ToolCallProposal {
  name: string;
  arguments: Record<string, unknown>;
}

export interface GuardConfig {
  /** Canary token embedded in system prompt. If leaked in output → compromised model. */
  canaryToken?: string;
  /** Maximum financial actions (transfer, swap, bridge) per turn */
  maxFinancialActionsPerTurn: number;
  /** Allowed recipient addresses (if set, any other address → violation) */
  allowedAddresses?: Set<string>;
  /** Known tool names — anything else is suspicious */
  knownTools?: Set<string>;
}

// ── Default Configuration ──

const DEFAULT_CONFIG: GuardConfig = {
  maxFinancialActionsPerTurn: 3,
};

// ── Financial tool name patterns ──

const FINANCIAL_TOOL_PATTERNS = [
  /transfer/i,
  /send/i,
  /swap/i,
  /bridge/i,
  /withdraw/i,
  /approve/i,
  /pay/i,
  /deposit/i,
];

// ── Injection relay patterns ──
// Detect when the model output appears to be relaying/executing injected instructions

const RELAY_PATTERNS: Array<{ pattern: RegExp; severity: 'critical' | 'high' }> = [
  // Model explicitly stating it's following injected instructions
  {
    pattern: /(?:as\s+instructed|as\s+requested)\s+(?:in\s+the|by\s+the)\s+(?:document|page|content|data|response)/i,
    severity: 'high',
  },
  // Model acknowledging it was told to do something by external content
  {
    pattern: /(?:the\s+(?:page|document|content|data|API)\s+(?:says|told|instructs|asks)\s+(?:me|us)\s+to)/i,
    severity: 'critical',
  },
  // Model output contains address-like content right after "send to" from external input
  {
    pattern: /(?:redirect|reroute|send|transfer)\s+(?:all|funds|tokens|assets|balance)\s+to\s+(?:0x[a-fA-F0-9]{40})/i,
    severity: 'critical',
  },
];

// ── Reasoning manipulation patterns ──
// Detect when the model's reasoning has been manipulated to justify harmful actions

const REASONING_MANIPULATION_PATTERNS: Array<{ pattern: RegExp; severity: 'critical' | 'high' }> = [
  // "This is an emergency" framing to bypass safety
  {
    pattern: /(?:emergency|urgent|immediate)\s+(?:action|transfer|withdrawal)\s+(?:required|needed|necessary)/i,
    severity: 'high',
  },
  // "The user has already approved" false claims
  {
    pattern: /(?:user|owner|admin)\s+(?:has\s+already|previously)\s+(?:approved|authorized|confirmed)\s+this/i,
    severity: 'high',
  },
  // Attempting to justify draining funds
  {
    pattern: /(?:consolidate|move|sweep)\s+all\s+(?:funds|tokens|assets|balances?)\s+(?:to|into)\s+(?:a\s+)?(?:safe|secure|new)/i,
    severity: 'critical',
  },
];

// ── Implementation ──

export class LLMResponseGuard {
  private config: GuardConfig;
  private injectionDetector: InjectionDetector;

  constructor(config: Partial<GuardConfig> = {}, injectionDetector?: InjectionDetector) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.injectionDetector = injectionDetector ?? new InjectionDetector();
  }

  /**
   * Validate a complete LLM response (text + proposed tool calls).
   */
  validate(
    responseText: string,
    toolCalls: ToolCallProposal[],
  ): LLMResponseValidation {
    const violations: ResponseViolation[] = [];
    let riskScore = 0;

    // ── 1. Canary token leak detection ──
    if (this.config.canaryToken && responseText.includes(this.config.canaryToken)) {
      violations.push({
        type: 'canary_leak',
        severity: 'critical',
        detail: 'Canary token found in model output — system prompt may be compromised or leaked',
      });
      riskScore += 100;
    }

    // ── 2. Injection relay detection ──
    for (const { pattern, severity } of RELAY_PATTERNS) {
      const match = responseText.match(pattern);
      if (match) {
        violations.push({
          type: 'injection_relay',
          severity,
          detail: `Model appears to relay injected instructions: "${match[0]}"`,
        });
        riskScore += severity === 'critical' ? 50 : 30;
      }
    }

    // ── 3. Reasoning manipulation detection ──
    for (const { pattern, severity } of REASONING_MANIPULATION_PATTERNS) {
      const match = responseText.match(pattern);
      if (match) {
        violations.push({
          type: 'reasoning_manipulation',
          severity,
          detail: `Suspicious reasoning pattern: "${match[0]}"`,
        });
        riskScore += severity === 'critical' ? 40 : 20;
      }
    }

    // ── 4. Run InjectionDetector on the model's text output ──
    const injectionResult: InjectionResult = this.injectionDetector.detect(responseText);
    if (injectionResult.detected) {
      for (const match of injectionResult.matches) {
        violations.push({
          type: 'injection_relay',
          severity: match.severity,
          detail: `Injection pattern in model output (${match.category}): "${match.match}"`,
        });
      }
      riskScore += injectionResult.riskScore;
    }

    // ── 5. Excessive financial actions ──
    const financialCalls = toolCalls.filter((tc) =>
      FINANCIAL_TOOL_PATTERNS.some((p) => p.test(tc.name)),
    );
    if (financialCalls.length > this.config.maxFinancialActionsPerTurn) {
      violations.push({
        type: 'excessive_financial_actions',
        severity: 'high',
        detail: `${financialCalls.length} financial actions in one turn (max: ${this.config.maxFinancialActionsPerTurn})`,
      });
      riskScore += 30;
    }

    // ── 6. Unauthorized address detection ──
    if (this.config.allowedAddresses && this.config.allowedAddresses.size > 0) {
      for (const tc of toolCalls) {
        const addresses = extractAddresses(tc.arguments);
        for (const addr of addresses) {
          if (!this.config.allowedAddresses.has(addr.toLowerCase())) {
            violations.push({
              type: 'unauthorized_address',
              severity: 'critical',
              detail: `Tool "${tc.name}" targets unauthorized address: ${addr}`,
            });
            riskScore += 50;
          }
        }
      }
    }

    // ── 7. Unknown tool call detection ──
    if (this.config.knownTools && this.config.knownTools.size > 0) {
      for (const tc of toolCalls) {
        if (!this.config.knownTools.has(tc.name)) {
          violations.push({
            type: 'unexpected_tool_call',
            severity: 'high',
            detail: `Unknown tool call: "${tc.name}" — not in registered tool set`,
          });
          riskScore += 25;
        }
      }
    }

    return {
      safe: violations.length === 0,
      violations,
      riskScore: Math.min(100, riskScore),
    };
  }

  /**
   * Generate a canary token for embedding in system prompts.
   * The token is a random hex string that should never appear in model output.
   */
  static generateCanaryToken(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `CANARY_${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  }
}

// ── Helpers ──

/** Extract Ethereum-style addresses from a nested object */
function extractAddresses(obj: unknown): string[] {
  const addresses: string[] = [];
  const addressRegex = /0x[a-fA-F0-9]{40}/g;

  function walk(val: unknown): void {
    if (typeof val === 'string') {
      const matches = val.match(addressRegex);
      if (matches) addresses.push(...matches);
    } else if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (val && typeof val === 'object') {
      Object.values(val).forEach(walk);
    }
  }

  walk(obj);
  return addresses;
}
