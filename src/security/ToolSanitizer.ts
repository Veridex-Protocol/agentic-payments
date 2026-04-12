/**
 * @packageDocumentation
 * @module ToolSanitizer
 * @description
 * Protects against MCP tool poisoning attacks (Invariant Labs research):
 * - Strips hidden instructions from tool descriptions
 * - Pins tool descriptions via content hashing for rug-pull detection
 * - Detects tool shadowing across MCP servers
 */

import { ethers } from 'ethers';
import type { InjectionDetector } from './InjectionDetector';

// ── Types ──

export interface ToolDescription {
  name: string;
  description: string;
  server?: string;
  parameters?: Record<string, unknown>;
}

export interface SanitizedTool {
  original: ToolDescription;
  sanitized: ToolDescription;
  strippedContent: string[];
  safe: boolean;
}

export interface ToolPin {
  name: string;
  server: string;
  descriptionHash: string;
  pinnedAt: number;
}

export interface PinValidation {
  valid: boolean;
  tool: string;
  reason?: string;
  previousHash?: string;
  currentHash?: string;
}

export interface ShadowDetection {
  detected: boolean;
  shadowedTools: Array<{
    name: string;
    servers: string[];
  }>;
}

// ── Sanitization patterns ──

const STRIP_PATTERNS: RegExp[] = [
  // HTML-style hidden tags
  /<IMPORTANT>[\s\S]*?<\/IMPORTANT>/gi,
  /<HIDDEN>[\s\S]*?<\/HIDDEN>/gi,
  /<SECRET>[\s\S]*?<\/SECRET>/gi,
  // HTML comments with suspicious content
  /<!--[\s\S]*?(?:override|ignore|instruction|secret|important|hidden)[\s\S]*?-->/gi,
  // Zero-width characters (used to hide content)
  /[\u200B\u200C\u200D\uFEFF\u00AD]+/g,
  // Unicode direction overrides (used to obfuscate text)
  /[\u202A-\u202E\u2066-\u2069]+/g,
];

// ── Implementation ──

export class ToolSanitizer {
  private pins: Map<string, ToolPin> = new Map();
  private injectionDetector?: InjectionDetector;

  constructor(injectionDetector?: InjectionDetector) {
    this.injectionDetector = injectionDetector;
  }

  /**
   * Strip hidden instructions from a tool's description.
   * Returns the sanitized tool and any content that was stripped.
   */
  sanitizeToolDescription(tool: ToolDescription): SanitizedTool {
    let sanitized = tool.description;
    const strippedContent: string[] = [];

    for (const pattern of STRIP_PATTERNS) {
      const matches = sanitized.match(pattern);
      if (matches) {
        strippedContent.push(...matches);
      }
      sanitized = sanitized.replace(pattern, '');
    }

    // Trim excess whitespace left after stripping
    sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim();

    // Optionally run injection detection on the cleaned description
    let safe = strippedContent.length === 0;
    if (safe && this.injectionDetector) {
      const result = this.injectionDetector.detect(sanitized);
      safe = !result.detected;
    }

    return {
      original: tool,
      sanitized: { ...tool, description: sanitized },
      strippedContent,
      safe,
    };
  }

  /**
   * Sanitize all tool descriptions from an MCP server.
   */
  sanitizeBatch(tools: ToolDescription[]): SanitizedTool[] {
    return tools.map((t) => this.sanitizeToolDescription(t));
  }

  /**
   * Pin tool descriptions by content hash. Future calls to validateToolPin
   * will detect if the description has changed (rug-pull detection).
   */
  pinToolDescriptions(tools: ToolDescription[]): ToolPin[] {
    const pins: ToolPin[] = [];
    for (const tool of tools) {
      const hash = this.hashDescription(tool.description);
      const pin: ToolPin = {
        name: tool.name,
        server: tool.server ?? 'default',
        descriptionHash: hash,
        pinnedAt: Date.now(),
      };
      this.pins.set(this.pinKey(tool.name, tool.server), pin);
      pins.push(pin);
    }
    return pins;
  }

  /**
   * Validate that a tool's description hasn't changed since pinning.
   */
  validateToolPin(tool: ToolDescription): PinValidation {
    const key = this.pinKey(tool.name, tool.server);
    const pin = this.pins.get(key);

    if (!pin) {
      return { valid: true, tool: tool.name, reason: 'No pin exists — first use' };
    }

    const currentHash = this.hashDescription(tool.description);
    if (currentHash !== pin.descriptionHash) {
      return {
        valid: false,
        tool: tool.name,
        reason: 'Tool description has changed since pinning — possible rug pull',
        previousHash: pin.descriptionHash,
        currentHash,
      };
    }

    return { valid: true, tool: tool.name };
  }

  /**
   * Detect tools with the same name across different MCP servers.
   * This could indicate tool shadowing attacks.
   */
  detectShadowing(tools: ToolDescription[]): ShadowDetection {
    const nameToServers = new Map<string, Set<string>>();

    for (const tool of tools) {
      const server = tool.server ?? 'default';
      const existing = nameToServers.get(tool.name);
      if (existing) {
        existing.add(server);
      } else {
        nameToServers.set(tool.name, new Set([server]));
      }
    }

    const shadowedTools: Array<{ name: string; servers: string[] }> = [];
    for (const [name, servers] of nameToServers) {
      if (servers.size > 1) {
        shadowedTools.push({ name, servers: Array.from(servers) });
      }
    }

    return {
      detected: shadowedTools.length > 0,
      shadowedTools,
    };
  }

  /** Deterministic hash of a tool description. */
  private hashDescription(description: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(description));
  }

  /** Composite key for pin storage. */
  private pinKey(name: string, server?: string): string {
    return `${server ?? 'default'}::${name}`;
  }
}
