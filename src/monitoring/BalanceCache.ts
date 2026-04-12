/**
 * @packageDocumentation
 * @module BalanceCache
 * @description
 * Short-lived cache for wallet balances to reduce RPC load.
 * 
 * Since agents might query balances frequently (e.g., before every transaction attempt),
 * this cache provides a TTL-based mechanism (default 10s) to serve recent balance data
 * without hitting the blockchain node repeatedly.
 */
import { TokenBalance } from '@veridex/sdk';

interface CachedBalance {
    tokens: TokenBalance[];
    timestamp: number;
}

export class BalanceCache {
    private cache: Map<string, CachedBalance> = new Map();
    private readonly TTL = 10000; // 10 seconds

    get(address: string, chainId: number): TokenBalance[] | null {
        const key = `${address}_${chainId}`;
        const entry = this.cache.get(key);

        if (entry && Date.now() - entry.timestamp < this.TTL) {
            return entry.tokens;
        }

        return null;
    }

    set(address: string, chainId: number, tokens: TokenBalance[]) {
        const key = `${address}_${chainId}`;
        this.cache.set(key, {
            tokens,
            timestamp: Date.now()
        });
    }

    clear() {
        this.cache.clear();
    }
}
