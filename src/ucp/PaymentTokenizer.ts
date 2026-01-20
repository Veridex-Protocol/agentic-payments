import { StoredSession } from '../session/SessionStorage';
import { ethers } from 'ethers';

export interface PaymentToken {
  token: string;
  keyHash: string;
  expiresAt: number;
  limits: {
    dailyLimitUSD: number;
    perTransactionLimitUSD: number;
  };
}

export interface TokenValidationResult {
  valid: boolean;
  reason?: string;
  session?: StoredSession;
}

/**
 * PaymentTokenizer - Generates and validates payment tokens for UCP checkout.
 * 
 * Tokens are:
 * - Derived from session keys
 * - Time-limited (inherit session expiry or shorter)
 * - Bound to original session spending limits
 */
export class PaymentTokenizer {
  private tokenCache: Map<string, { session: StoredSession; expiresAt: number }> = new Map();
  private readonly TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes default

  /**
   * Generate a payment token from a session.
   */
  async tokenize(session: StoredSession, customTtlMs?: number): Promise<PaymentToken> {
    const ttl = customTtlMs || this.TOKEN_TTL_MS;
    const expiresAt = Math.min(
      Date.now() + ttl,
      session.config.expiryTimestamp
    );

    const tokenData = {
      keyHash: session.keyHash,
      type: 'VERIDEX_SESSION_TOKEN',
      limits: {
        dailyLimitUSD: session.config.dailyLimitUSD,
        perTransactionLimitUSD: session.config.perTransactionLimitUSD,
      },
      expiresAt,
      nonce: ethers.hexlify(ethers.randomBytes(16)),
    };

    const tokenString = Buffer.from(JSON.stringify(tokenData)).toString('base64url');

    // Cache for validation
    this.tokenCache.set(tokenString, { session, expiresAt });

    return {
      token: tokenString,
      keyHash: session.keyHash,
      expiresAt,
      limits: tokenData.limits,
    };
  }

  /**
   * Validate a payment token and return the associated session.
   */
  validate(token: string): TokenValidationResult {
    // Check cache first
    const cached = this.tokenCache.get(token);
    if (!cached) {
      // Try to decode and validate structurally
      try {
        const decoded = JSON.parse(Buffer.from(token, 'base64url').toString());
        if (decoded.type !== 'VERIDEX_SESSION_TOKEN') {
          return { valid: false, reason: 'Invalid token type' };
        }
        if (decoded.expiresAt < Date.now()) {
          return { valid: false, reason: 'Token expired' };
        }
        // Token is structurally valid but not in cache - may have been issued elsewhere
        return { valid: false, reason: 'Token not found in cache - may be stale' };
      } catch {
        return { valid: false, reason: 'Malformed token' };
      }
    }

    // Check expiration
    if (cached.expiresAt < Date.now()) {
      this.tokenCache.delete(token);
      return { valid: false, reason: 'Token expired' };
    }

    // Check if underlying session is still valid
    if (cached.session.config.expiryTimestamp < Date.now()) {
      this.tokenCache.delete(token);
      return { valid: false, reason: 'Underlying session expired' };
    }

    return { valid: true, session: cached.session };
  }

  /**
   * Refresh a token, extending its validity if the session permits.
   */
  async refresh(oldToken: string, session: StoredSession): Promise<PaymentToken | null> {
    const validation = this.validate(oldToken);
    if (!validation.valid) {
      return null;
    }

    // Invalidate old token
    this.tokenCache.delete(oldToken);

    // Issue new token
    return this.tokenize(session);
  }

  /**
   * Revoke a token immediately.
   */
  revoke(token: string): boolean {
    return this.tokenCache.delete(token);
  }

  /**
   * Revoke all tokens for a session.
   */
  revokeAllForSession(keyHash: string): number {
    let count = 0;
    for (const [token, cached] of this.tokenCache.entries()) {
      if (cached.session.keyHash === keyHash) {
        this.tokenCache.delete(token);
        count++;
      }
    }
    return count;
  }

  /**
   * Clean up expired tokens from cache.
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, cached] of this.tokenCache.entries()) {
      if (cached.expiresAt < now) {
        this.tokenCache.delete(token);
        cleaned++;
      }
    }
    return cleaned;
  }
}
