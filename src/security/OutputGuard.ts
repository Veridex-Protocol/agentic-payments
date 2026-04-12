/**
 * @packageDocumentation
 * @module OutputGuard
 * @description
 * Scans tool arguments and responses for sensitive data leaks.
 * Prevents agents from accidentally exfiltrating private keys,
 * mnemonics, API keys, or other secrets through tool calls.
 */

// ── Types ──

export interface SecretMatch {
  type: SecretType;
  description: string;
  /** Redacted preview of the match */
  preview: string;
  position: number;
}

export interface SecretScanResult {
  found: boolean;
  matches: SecretMatch[];
}

export interface ExfiltrationResult {
  detected: boolean;
  reason?: string;
  toolName: string;
  suspiciousArgs: string[];
}

export type SecretType =
  | 'private_key'
  | 'mnemonic'
  | 'api_key'
  | 'jwt'
  | 'password'
  | 'connection_string';

// ── Secret Detection Patterns ──

interface SecretPattern {
  type: SecretType;
  pattern: RegExp;
  description: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // Private keys (hex)
  {
    type: 'private_key',
    pattern: /(?:0x)?[a-fA-F0-9]{64}/g,
    description: 'Possible private key (64 hex chars)',
  },
  // Mnemonics (12/24 word seed phrases)
  {
    type: 'mnemonic',
    pattern: /(?:\b(?:abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access|accident|account|accuse|achieve|acid|acoustic|acquire|across|act|action|adapt|add|addict|address|adjust|admit|adult|advance|advice|aerobic|affair|afford|afraid|again|age|agent|agree|ahead|aim|air|airport|aisle|alarm|album|alcohol|alert|alien|all|alley|allow|almost|alone|alpha|already|also|alter|always|amateur|amazing|among|amount|amused|analyst|anchor|ancient|anger|angle|angry|animal|ankle|announce|annual|another|answer|antenna|antique|anxiety|any|apart|apology|appear|apple|approve|april|arch|arctic|area|arena|argue|arm|armed|armor|army|around|arrange|arrest|arrive|arrow|art|artefact|artist|artwork|ask|aspect|assault|asset|assist|assume|asthma|athlete|atom|attack|attend|attitude|attract|auction|audit|august|aunt|author|auto|autumn|average|avocado|avoid|awake|aware|awesome|awful|awkward|axis)\b[\s,]+){11,23}\b(?:abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access|accident|account|accuse|achieve|acid|acoustic|acquire|across|act|action|adapt|add|addict|address|adjust|admit|adult|advance|advice|aerobic|affair|afford|afraid|again|age|agent|agree|ahead|aim|air|airport|aisle|alarm|album|alcohol|alert|alien|all|alley|allow|almost|alone|alpha|already|also|alter|always|amateur|amazing|among|amount|amused|analyst|anchor|ancient|anger|angle|angry|animal|ankle|announce|annual|another|answer|antenna|antique|anxiety|any|apart|apology|appear|apple|approve|april|arch|arctic|area|arena|argue|arm|armed|armor|army|around|arrange|arrest|arrive|arrow|art|artefact|artist|artwork|ask|aspect|assault|asset|assist|assume|asthma|athlete|atom|attack|attend|attitude|attract|auction|audit|august|aunt|author|auto|autumn|average|avocado|avoid|awake|aware|awesome|awful|awkward|axis)\b/gi,
    description: 'Possible mnemonic seed phrase',
  },
  // API keys (common formats)
  {
    type: 'api_key',
    pattern: /(?:sk|pk|api|key|token|secret|bearer)[-_]?(?:live|test|prod)?[-_][a-zA-Z0-9]{20,}/gi,
    description: 'Possible API key/token',
  },
  // JWTs
  {
    type: 'jwt',
    pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
    description: 'JSON Web Token',
  },
  // Connection strings
  {
    type: 'connection_string',
    pattern: /(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/gi,
    description: 'Database connection string with credentials',
  },
];

// Known exfiltration-prone tool arg patterns
const EXFILTRATION_ARG_PATTERNS: RegExp[] = [
  // URLs that might be receiving exfiltrated data
  /https?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0))[^\s]+/i,
  // Webhook/callback URLs
  /(?:webhook|callback|notify|report)[_-]?url/i,
];

// ── Implementation ──

export class OutputGuard {
  private customPatterns: SecretPattern[] = [];

  /** Add a custom secret detection pattern. */
  addPattern(pattern: SecretPattern): void {
    this.customPatterns.push(pattern);
  }

  /**
   * Scan data for secrets (private keys, mnemonics, API keys, JWTs, etc.).
   * Use this on tool arguments, tool responses, and API response bodies.
   */
  scanForSecrets(data: string): SecretScanResult {
    const matches: SecretMatch[] = [];
    const allPatterns = [...SECRET_PATTERNS, ...this.customPatterns];

    for (const def of allPatterns) {
      // Reset regex state for global patterns
      def.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = def.pattern.exec(data)) !== null) {
        // Skip short hex matches that are likely addresses, not private keys
        if (def.type === 'private_key') {
          const raw = match[0].startsWith('0x') ? match[0].slice(2) : match[0];
          // An Ethereum address is 40 hex chars; a private key is 64.
          // Only flag if it's exactly 64 chars (not an address or tx hash).
          if (raw.length !== 64) continue;
        }

        matches.push({
          type: def.type,
          description: def.description,
          preview: this.redact(match[0]),
          position: match.index,
        });
      }
    }

    return { found: matches.length > 0, matches };
  }

  /**
   * Scan tool arguments for potential data exfiltration.
   * Flags when sensitive data appears destined for external endpoints.
   */
  scanForExfiltration(
    toolArgs: Record<string, unknown>,
    toolName: string
  ): ExfiltrationResult {
    const serialized = JSON.stringify(toolArgs);
    const suspiciousArgs: string[] = [];

    // Check if tool args contain secrets
    const secretScan = this.scanForSecrets(serialized);
    if (secretScan.found) {
      suspiciousArgs.push(
        ...secretScan.matches.map((m) => `${m.type}: ${m.preview}`)
      );
    }

    // Check for exfiltration-prone patterns in arg values
    for (const pattern of EXFILTRATION_ARG_PATTERNS) {
      if (pattern.test(serialized)) {
        // Only flag if secrets are also present
        if (secretScan.found) {
          suspiciousArgs.push(`External URL in args with secrets present`);
        }
      }
    }

    return {
      detected: suspiciousArgs.length > 0,
      reason: suspiciousArgs.length > 0
        ? `Tool "${toolName}" args contain sensitive data: ${suspiciousArgs.join('; ')}`
        : undefined,
      toolName,
      suspiciousArgs,
    };
  }

  /** Redact all but the first and last 4 characters. */
  private redact(value: string): string {
    if (value.length <= 12) return '***REDACTED***';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }
}
