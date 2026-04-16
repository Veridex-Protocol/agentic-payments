/**
 * @packageDocumentation
 * @module x402NonceManager
 * @description
 * Generates cryptographic nonces for x402 payment headers.
 * 
 * Ensures that every payment request is unique to prevent replay attacks
 * at the protocol level. Includes server-side nonce validation with
 * time-based expiry to prevent replay attacks (VDX-PAY-003).
 */
import { ethers } from 'ethers';

/** Nonce expiry: 24 hours */
const NONCE_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** Maximum stored nonces per key before pruning */
const MAX_NONCES_PER_KEY = 10_000;

interface NonceEntry {
  nonce: string;
  createdAt: number;
}

export class NonceManager {
  /** Client-side nonce generation tracking */
  private nonces: Map<string, NonceEntry[]> = new Map();
  /** Server-side consumed nonces for replay protection (VDX-PAY-003) */
  private consumedNonces: Set<string> = new Set();

  getNextNonce(keyHash: string): string {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const entries = this.nonces.get(keyHash) || [];
    entries.push({ nonce, createdAt: Date.now() });

    // Prune expired nonces to prevent unbounded memory growth
    const cutoff = Date.now() - NONCE_EXPIRY_MS;
    const pruned = entries.filter(e => e.createdAt > cutoff);
    if (pruned.length > MAX_NONCES_PER_KEY) {
      pruned.splice(0, pruned.length - MAX_NONCES_PER_KEY);
    }
    this.nonces.set(keyHash, pruned);

    return nonce;
  }

  isUsed(keyHash: string, nonce: string): boolean {
    return (this.nonces.get(keyHash) || []).some(e => e.nonce === nonce);
  }

  /**
   * VDX-PAY-003: Server-side nonce validation.
   * Atomically checks if a nonce has been consumed and marks it as used.
   * Returns true if the nonce is valid (first use), false if replayed.
   *
   * Note: In production multi-instance deployments, replace with
   * Redis SETNX: `SET nonce:{keyHash}:{nonce} 1 NX EX 86400`
   */
  validateAndConsume(keyHash: string, nonce: string): boolean {
    const compositeKey = `${keyHash}:${nonce}`;
    if (this.consumedNonces.has(compositeKey)) {
      return false; // Replay detected
    }
    this.consumedNonces.add(compositeKey);

    // Periodic cleanup: cap set size to prevent unbounded growth
    if (this.consumedNonces.size > MAX_NONCES_PER_KEY * 100) {
      // In-memory only: clear oldest half.
      // Production should use Redis with TTL instead.
      const entries = Array.from(this.consumedNonces);
      const toRemove = entries.slice(0, entries.length / 2);
      for (const key of toRemove) {
        this.consumedNonces.delete(key);
      }
    }

    return true;
  }
}
