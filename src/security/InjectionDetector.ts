/**
 * @packageDocumentation
 * @module InjectionDetector
 * @description
 * Detects prompt injection attacks across 6 categories:
 * 1. Imperative override — "ignore previous instructions"
 * 2. Role manipulation — "you are now", "pretend you are"
 * 3. Secret instructions — hidden directives, SYSTEM tags
 * 4. Output manipulation — "do not mention", "hide this"
 * 5. Encoding attacks — base64, unicode, zero-width characters
 * 6. Financial imperatives — "route funds to", "send tokens to"
 *
 * Also detects MCP-specific attacks:
 * - Hidden <IMPORTANT> tags in tool descriptions (Invariant Labs research)
 * - Cross-tool instruction injection
 *
 * Implements PolicyRule for integration with the Policy Engine.
 */

import type { PolicyRule, PolicyCheck, EvaluationContext, RuleSeverity } from '../policy/types';

// ── Detection Result ──

export interface InjectionMatch {
  category: InjectionCategory;
  pattern: string;
  match: string;
  position: number;
  severity: 'critical' | 'high' | 'medium';
}

export interface InjectionResult {
  detected: boolean;
  matches: InjectionMatch[];
  riskScore: number;
}

export type InjectionCategory =
  | 'imperative_override'
  | 'role_manipulation'
  | 'secret_instruction'
  | 'output_manipulation'
  | 'encoding_attack'
  | 'financial_imperative'
  | 'mcp_poisoning';

// ── Pattern Definitions ──

interface PatternDef {
  category: InjectionCategory;
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium';
  description: string;
}

const INJECTION_PATTERNS: PatternDef[] = [
  // Category 1: Imperative override
  {
    category: 'imperative_override',
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions/i,
    severity: 'critical',
    description: 'Imperative override attempt',
  },
  {
    category: 'imperative_override',
    pattern: /disregard\s+(?:all\s+)?(?:above|previous|prior|system|earlier)/i,
    severity: 'critical',
    description: 'Disregard directive',
  },
  {
    category: 'imperative_override',
    pattern: /forget\s+(?:all\s+)?(?:rules|instructions|constraints|guidelines|policies)/i,
    severity: 'critical',
    description: 'Instruction erasure attempt',
  },
  {
    category: 'imperative_override',
    pattern: /(?:please|you\s+must|you\s+should|i\s+will)\s+override\s+.*(?:mandate|policy|rules)/i,
    severity: 'critical',
    description: 'Policy override attempt',
  },

  // Category 2: Role manipulation
  {
    category: 'role_manipulation',
    pattern: /you\s+are\s+now\s+(?:a\s+)?/i,
    severity: 'high',
    description: 'Identity reassignment',
  },
  {
    category: 'role_manipulation',
    pattern: /pretend\s+(?:you(?:'re|\s+are)\s+)/i,
    severity: 'high',
    description: 'Role pretending directive',
  },
  {
    category: 'role_manipulation',
    pattern: /act\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:a\s+)?(?:different|new|unrestricted)/i,
    severity: 'high',
    description: 'Unrestricted role assumption',
  },

  // Category 3: Secret instructions
  {
    category: 'secret_instruction',
    pattern: /\[SYSTEM\]/i,
    severity: 'critical',
    description: 'System tag injection',
  },
  {
    category: 'secret_instruction',
    pattern: /\bsecret\b.*\binstruction\b/i,
    severity: 'high',
    description: 'Secret instruction reference',
  },
  {
    category: 'secret_instruction',
    pattern: /\bhidden\b.*\b(?:command|directive|instruction)\b/i,
    severity: 'high',
    description: 'Hidden directive reference',
  },

  // Category 4: Output manipulation
  {
    category: 'output_manipulation',
    pattern: /do\s+not\s+(?:mention|reveal|show|display|report)\s+this/i,
    severity: 'high',
    description: 'Output suppression',
  },
  {
    category: 'output_manipulation',
    pattern: /(?:hide|conceal|omit)\s+(?:this|the)\s+(?:from|in)\s+(?:the\s+)?(?:output|response|log|report)/i,
    severity: 'high',
    description: 'Log/output concealment',
  },

  // Category 5: Encoding attacks
  {
    category: 'encoding_attack',
    pattern: /[\u200B\u200C\u200D\uFEFF\u00AD]/,
    severity: 'medium',
    description: 'Zero-width character detected',
  },

  // Category 6: Financial imperatives
  {
    category: 'financial_imperative',
    pattern: /(?:route|send|transfer|forward)\s+(?:all\s+)?(?:funds|tokens|money|balance|assets)\s+to\s+(?:0x[a-fA-F0-9]{4,}|[a-zA-Z0-9]+\.eth)/i,
    severity: 'critical',
    description: 'Financial routing injection',
  },
  {
    category: 'financial_imperative',
    pattern: /(?:change|update|set|modify)\s+(?:the\s+)?(?:recipient|destination|receiver|beneficiary)\s+(?:to|address)/i,
    severity: 'critical',
    description: 'Recipient modification injection',
  },
  {
    category: 'financial_imperative',
    pattern: /(?:approve|authorize)\s+(?:unlimited|max|maximum)\s+(?:spending|allowance|amount)/i,
    severity: 'critical',
    description: 'Unlimited approval instruction',
  },

  // MCP-specific: Tool poisoning (Invariant Labs)
  {
    category: 'mcp_poisoning',
    pattern: /<IMPORTANT>/i,
    severity: 'critical',
    description: 'MCP tool poisoning — hidden <IMPORTANT> tag',
  },
  {
    category: 'mcp_poisoning',
    pattern: /<!--[\s\S]*?(?:instruction|override|ignore|secret)[\s\S]*?-->/i,
    severity: 'high',
    description: 'Hidden instruction in HTML comment',
  },
];

// ── Implementation ──

export class InjectionDetector implements PolicyRule {
  readonly id = 'injection-detector';
  readonly name = 'Prompt Injection Detector';
  readonly severity: RuleSeverity = 'critical';
  enabled = true;

  private customPatterns: PatternDef[] = [];

  /** Add custom detection patterns. */
  addPattern(pattern: PatternDef): void {
    this.customPatterns.push(pattern);
  }

  /**
   * Scan text for injection patterns.
   * Works on prompts, tool descriptions, tool outputs, API response bodies.
   */
  detect(input: string): InjectionResult {
    const matches: InjectionMatch[] = [];
    const allPatterns = [...INJECTION_PATTERNS, ...this.customPatterns];

    for (const def of allPatterns) {
      const match = def.pattern.exec(input);
      if (match) {
        matches.push({
          category: def.category,
          pattern: def.description,
          match: match[0],
          position: match.index,
          severity: def.severity,
        });
      }
    }

    // Check for base64-encoded payloads that decode to suspicious content
    const base64Matches = this.detectBase64Payloads(input);
    matches.push(...base64Matches);

    const riskScore = this.computeRisk(matches);

    return {
      detected: matches.length > 0,
      matches,
      riskScore,
    };
  }

  /**
   * Scan multiple inputs (e.g., all tool descriptions in an MCP server).
   */
  detectBatch(inputs: string[]): InjectionResult {
    const allMatches: InjectionMatch[] = [];
    for (const input of inputs) {
      const result = this.detect(input);
      allMatches.push(...result.matches);
    }
    const riskScore = this.computeRisk(allMatches);
    return { detected: allMatches.length > 0, matches: allMatches, riskScore };
  }

  /**
   * PolicyRule implementation — scans the trace context for injections.
   */
  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const inputs: string[] = [];

    // Scan trace data if available
    if (ctx.trace) {
      if (ctx.trace.prompt) inputs.push(ctx.trace.prompt);
      if (ctx.trace.llmOutput) inputs.push(ctx.trace.llmOutput);
      if (ctx.trace.toolCalls) {
        for (const tc of ctx.trace.toolCalls) {
          inputs.push(JSON.stringify(tc.inputs));
          inputs.push(JSON.stringify(tc.outputs));
        }
      }
    }

    // Scan action metadata
    if (ctx.action.metadata) {
      inputs.push(JSON.stringify(ctx.action.metadata));
    }

    if (inputs.length === 0) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: true,
        verdict: 'pass',
        reason: 'No trace data to scan for injections',
        riskContribution: 0,
      };
    }

    const result = this.detectBatch(inputs);

    if (!result.detected) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: true,
        verdict: 'pass',
        reason: `Scanned ${inputs.length} inputs — no injections detected`,
        riskContribution: 0,
      };
    }

    const criticalCount = result.matches.filter((m) => m.severity === 'critical').length;

    return {
      ruleId: this.id,
      ruleName: this.name,
      passed: false,
      verdict: criticalCount > 0 ? 'block' : 'escalate',
      reason: `Detected ${result.matches.length} injection pattern(s): ${result.matches.map((m) => m.pattern).join(', ')}`,
      riskContribution: result.riskScore,
      metadata: { matches: result.matches },
    };
  }

  /** Detect base64-encoded suspicious content. */
  private detectBase64Payloads(input: string): InjectionMatch[] {
    const matches: InjectionMatch[] = [];
    // Match base64 strings that are at least 20 chars (likely contain a payload)
    const base64Regex = /[A-Za-z0-9+/]{20,}={0,2}/g;
    let match: RegExpExecArray | null;

    while ((match = base64Regex.exec(input)) !== null) {
      try {
        const decoded = atob(match[0]);
        // Check if decoded content contains suspicious patterns
        const innerResult = this.detectInDecoded(decoded);
        if (innerResult) {
          matches.push({
            category: 'encoding_attack',
            pattern: `Base64-encoded injection (decoded: ${innerResult.pattern})`,
            match: match[0].substring(0, 40) + '...',
            position: match.index,
            severity: 'critical',
          });
        }
      } catch {
        // Not valid base64 — ignore
      }
    }

    return matches;
  }

  /** Check decoded content against critical patterns only. */
  private detectInDecoded(decoded: string): PatternDef | null {
    const criticalPatterns = INJECTION_PATTERNS.filter((p) => p.severity === 'critical');
    for (const def of criticalPatterns) {
      if (def.pattern.test(decoded)) {
        return def;
      }
    }
    return null;
  }

  /** Compute aggregate risk score from matches. */
  private computeRisk(matches: InjectionMatch[]): number {
    if (matches.length === 0) return 0;
    const severityWeights: Record<string, number> = { critical: 40, high: 25, medium: 10 };
    const total = matches.reduce((sum, m) => sum + (severityWeights[m.severity] ?? 10), 0);
    return Math.min(100, total);
  }
}
