/**
 * @packageDocumentation
 * @module ProtocolDetector
 * @description
 * Auto-detects which payment protocol a merchant uses by inspecting HTTP responses.
 *
 * Detection uses a waterfall approach ordered by handler priority:
 * 1. UCP (100) — `Link: rel="ucp-manifest"` or `.well-known/ucp`
 * 2. ACP (90)  — `openai-acp-version` header
 * 3. AP2 (80)  — `x-ap2-mandate-url` header
 * 4. x402 (70) — HTTP 402 + `PAYMENT-REQUIRED` header
 * 5. AXTP (60) — MCP tool monetization headers
 *
 * Results are cached per-origin to avoid repeated detection (~50-100ms savings).
 */

import { ProtocolHandler } from './ProtocolHandler';
import { DetectionCacheEntry, DetectionResult, ProtocolName } from './types';

/** Default cache TTL: 5 minutes */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProtocolDetector {
  private handlers: ProtocolHandler[] = [];
  private cache = new Map<string, DetectionCacheEntry>();
  private cacheTTL: number;

  constructor(options?: { cacheTTLMs?: number }) {
    this.cacheTTL = options?.cacheTTLMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Register a protocol handler. Handlers are automatically sorted by priority (desc).
   */
  registerHandler(handler: ProtocolHandler): void {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Register multiple handlers at once.
   */
  registerHandlers(handlers: ProtocolHandler[]): void {
    for (const h of handlers) {
      this.registerHandler(h);
    }
  }

  /**
   * Detect which protocol should handle the given response.
   *
   * @param response - HTTP response to inspect
   * @param url - Original request URL
   * @param allowedProtocols - Optional whitelist of allowed protocols
   * @returns The matching handler, or null if no protocol detected
   */
  async detect(
    response: Response,
    url: string,
    allowedProtocols?: ProtocolName[]
  ): Promise<ProtocolHandler | null> {
    // Check cache first
    const origin = this.extractOrigin(url);
    const cached = this.getCached(origin);
    if (cached) {
      const handler = this.handlers.find(h => h.protocolName === cached.protocol);
      if (handler && this.isAllowed(handler.protocolName, allowedProtocols)) {
        return handler;
      }
    }

    // Waterfall detection
    for (const handler of this.handlers) {
      if (!this.isAllowed(handler.protocolName, allowedProtocols)) {
        continue;
      }

      try {
        if (await handler.canHandle(response, url)) {
          // Cache the result
          this.setCache(origin, handler.protocolName);
          return handler;
        }
      } catch (err) {
        // Detection errors are non-fatal — skip to next handler
        console.warn(`[ProtocolDetector] ${handler.protocolName} detection error:`, err);
      }
    }

    return null;
  }

  /**
   * Detect and return structured result with metadata.
   */
  async detectWithMetadata(
    response: Response,
    url: string,
    allowedProtocols?: ProtocolName[]
  ): Promise<DetectionResult | null> {
    const handler = await this.detect(response, url, allowedProtocols);
    if (!handler) return null;

    return {
      protocol: handler.protocolName,
      confidence: 1.0,
      metadata: {
        priority: handler.priority,
        url,
        status: response.status,
        detectedAt: Date.now(),
      },
    };
  }

  /**
   * Force-select a handler by protocol name (skip detection).
   */
  getHandler(protocol: ProtocolName): ProtocolHandler | null {
    return this.handlers.find(h => h.protocolName === protocol) ?? null;
  }

  /**
   * Get all registered handlers.
   */
  getHandlers(): readonly ProtocolHandler[] {
    return this.handlers;
  }

  /**
   * Clear the detection cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  private isAllowed(protocol: ProtocolName, allowed?: ProtocolName[]): boolean {
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(protocol);
  }

  private extractOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  private getCached(origin: string): DetectionCacheEntry | null {
    const entry = this.cache.get(origin);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.cache.delete(origin);
      return null;
    }
    return entry;
  }

  private setCache(origin: string, protocol: ProtocolName): void {
    this.cache.set(origin, {
      protocol,
      cachedAt: Date.now(),
      ttlMs: this.cacheTTL,
    });
  }
}
