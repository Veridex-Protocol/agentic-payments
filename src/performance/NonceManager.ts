/**
 * @packageDocumentation
 * @module NonceManager
 * @description
 * Optimistic Nonce Management for High-Frequency Trading.
 * 
 * Standard RPC nonce fetching is too slow for agents executing multiple transactions per second.
 * This class tracks nonces strictly client-side to allow "fire and forget" transaction submission
 * without waiting for the previous one to be mined.
 * 
 * Features:
 * - **Optimistic Increment**: Immediately increments nonce upon reservation.
 * - **Pending Queue**: Tracks nonces for in-flight transactions.
 * - **Reorg Handling**: Can be reset if on-chain state diverges.
 */

export class NonceManager {
    private nonceCache: Map<string, bigint> = new Map();
    private pendingNonces: Map<string, Set<bigint>> = new Map();

    /**
     * Get the next nonce for a key, using cached value if available.
     */
    getNextNonce(keyHash: string, currentOnChain?: bigint): bigint {
        const cached = this.nonceCache.get(keyHash);
        const pending = this.pendingNonces.get(keyHash) || new Set();

        let nextNonce: bigint;

        if (currentOnChain !== undefined) {
            // Update cache with on-chain value
            this.nonceCache.set(keyHash, currentOnChain);
            nextNonce = currentOnChain;
        } else if (cached !== undefined) {
            nextNonce = cached;
        } else {
            // Default to 0 if no cached value
            nextNonce = BigInt(0);
        }

        // Find next available nonce (accounting for pending transactions)
        while (pending.has(nextNonce)) {
            nextNonce++;
        }

        return nextNonce;
    }

    /**
     * Reserve a nonce for a pending transaction.
     */
    reserveNonce(keyHash: string, nonce: bigint): void {
        if (!this.pendingNonces.has(keyHash)) {
            this.pendingNonces.set(keyHash, new Set());
        }
        this.pendingNonces.get(keyHash)!.add(nonce);
    }

    /**
     * Release a nonce (transaction failed or was cancelled).
     */
    releaseNonce(keyHash: string, nonce: bigint): void {
        this.pendingNonces.get(keyHash)?.delete(nonce);
    }

    /**
     * Confirm a nonce was used (transaction succeeded).
     */
    confirmNonce(keyHash: string, nonce: bigint): void {
        this.pendingNonces.get(keyHash)?.delete(nonce);
        const current = this.nonceCache.get(keyHash) || BigInt(0);
        if (nonce >= current) {
            this.nonceCache.set(keyHash, nonce + BigInt(1));
        }
    }

    /**
     * Get all pending nonces for a key.
     */
    getPendingNonces(keyHash: string): bigint[] {
        return Array.from(this.pendingNonces.get(keyHash) || []);
    }

    /**
     * Clear cache for a key (e.g., after session revocation).
     */
    clearCache(keyHash: string): void {
        this.nonceCache.delete(keyHash);
        this.pendingNonces.delete(keyHash);
    }
}
