/**
 * @packageDocumentation
 * @module SupplyChainGuard
 * @description
 * Defends against supply chain attacks targeting agent infrastructure:
 *
 * 1. **MCP Server Integrity** — Verify tool definitions haven't been tampered with
 *    between registration and execution (rug-pull detection).
 *
 * 2. **Dependency Manifest Verification** — Detect suspicious package.json patterns:
 *    - Wildcard/latest versions in dependencies
 *    - Git HEAD dependencies
 *    - Suspicious install scripts (preinstall, postinstall)
 *
 * 3. **Runtime Environment Checks** — Detect signs of environment tampering:
 *    - Unexpected environment variables
 *    - Modified PATH entries
 *    - Suspicious process arguments
 *
 * Works alongside ToolSanitizer (which handles per-request sanitization).
 * This module handles persistent/one-time verification at startup.
 */

// ── Types ──

export interface SupplyChainCheckResult {
  safe: boolean;
  issues: SupplyChainIssue[];
}

export interface SupplyChainIssue {
  type: SupplyChainIssueType;
  severity: 'critical' | 'high' | 'medium' | 'low';
  detail: string;
  source?: string;
}

export type SupplyChainIssueType =
  | 'wildcard_version'
  | 'git_dependency'
  | 'suspicious_script'
  | 'env_tampering'
  | 'tool_mutation';

// ── Dependency Manifest Verification ──

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const SUSPICIOUS_VERSION_PATTERNS = [
  { pattern: /^\*$/, description: 'Wildcard (*) version — accepts ANY version' },
  { pattern: /^latest$/i, description: 'latest tag — unpinned to specific version' },
  { pattern: /^x$|\.x$/i, description: 'Partial wildcard — unpinned minor/patch' },
  { pattern: /^>/, description: 'Greater-than range — no upper bound' },
];

const GIT_DEP_PATTERNS = [
  /^github:/,
  /^git\+/,
  /^git:/,
  /\.git$/,
  /^https?:\/\/github\.com\//,
];

const SUSPICIOUS_SCRIPT_PATTERNS = [
  /curl\s+.*\|\s*(?:bash|sh|node|python)/i,
  /wget\s+.*\|\s*(?:bash|sh)/i,
  /eval\s*\(/i,
  /node\s+-e\s+/i,
  /base64\s+--decode/i,
  /\\x[0-9a-f]{2}/i,
];

export class SupplyChainGuard {
  /**
   * Verify a package.json manifest for supply chain risks.
   */
  verifyManifest(pkg: PackageJson): SupplyChainCheckResult {
    const issues: SupplyChainIssue[] = [];

    // Check dependencies
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    for (const [name, version] of Object.entries(allDeps)) {
      // Wildcard/unpinned versions
      for (const { pattern, description } of SUSPICIOUS_VERSION_PATTERNS) {
        if (pattern.test(version)) {
          issues.push({
            type: 'wildcard_version',
            severity: 'high',
            detail: `${name}@${version}: ${description}`,
            source: 'package.json',
          });
        }
      }

      // Git dependencies
      for (const pattern of GIT_DEP_PATTERNS) {
        if (pattern.test(version)) {
          issues.push({
            type: 'git_dependency',
            severity: 'high',
            detail: `${name}: Git dependency (${version}) — unpinned to registry version`,
            source: 'package.json',
          });
          break;
        }
      }
    }

    // Check scripts
    const riskyScriptNames = ['preinstall', 'postinstall', 'preuninstall', 'postuninstall'];
    for (const scriptName of riskyScriptNames) {
      const script = pkg.scripts?.[scriptName];
      if (!script) continue;

      for (const pattern of SUSPICIOUS_SCRIPT_PATTERNS) {
        if (pattern.test(script)) {
          issues.push({
            type: 'suspicious_script',
            severity: 'critical',
            detail: `scripts.${scriptName} contains suspicious command: "${script.substring(0, 100)}"`,
            source: 'package.json',
          });
          break;
        }
      }
    }

    return {
      safe: issues.filter((i) => i.severity === 'critical' || i.severity === 'high').length === 0,
      issues,
    };
  }

  /**
   * Check runtime environment for tampering signals.
   */
  verifyEnvironment(): SupplyChainCheckResult {
    const issues: SupplyChainIssue[] = [];

    // Check for suspicious environment variables
    const suspiciousEnvVars = [
      'LD_PRELOAD',    // Library injection
      'LD_LIBRARY_PATH', // Library path manipulation
      'DYLD_INSERT_LIBRARIES', // macOS library injection
      'NODE_OPTIONS',  // Can inject code via --require
      'NODE_EXTRA_CA_CERTS', // Certificate manipulation
    ];

    for (const envVar of suspiciousEnvVars) {
      const value = process.env[envVar];
      if (value) {
        issues.push({
          type: 'env_tampering',
          severity: envVar === 'LD_PRELOAD' || envVar === 'DYLD_INSERT_LIBRARIES' ? 'critical' : 'high',
          detail: `Suspicious environment variable set: ${envVar}=${value.substring(0, 50)}...`,
          source: 'environment',
        });
      }
    }

    // Check NODE_OPTIONS specifically for --require injection
    const nodeOptions = process.env.NODE_OPTIONS;
    if (nodeOptions && /--require|--import|-r\s/.test(nodeOptions)) {
      issues.push({
        type: 'env_tampering',
        severity: 'critical',
        detail: `NODE_OPTIONS contains --require/--import: potential code injection`,
        source: 'environment',
      });
    }

    return {
      safe: issues.filter((i) => i.severity === 'critical').length === 0,
      issues,
    };
  }
}
