/**
 * Parallel Route Finder - Optimized Cross-Chain Route Discovery
 * 
 * Implements parallel route finding with:
 * - Concurrent balance queries across all chains
 * - Parallel fee estimation
 * - Route scoring and ranking
 * - Timeout handling
 * - Caching for repeated queries
 */

export interface ChainBalance {
    chain: number;
    chainName: string;
    token: string;
    balance: bigint;
    balanceUSD: number;
}

export interface RouteCandidate {
    id: string;
    sourceChain: number;
    targetChain: number;
    sourceToken: string;
    targetToken: string;
    estimatedFeeUSD: number;
    estimatedTimeMs: number;
    hops: RouteHop[];
    score: number;
    metadata?: Record<string, unknown>;
}

export interface RouteHop {
    type: 'transfer' | 'bridge' | 'swap';
    fromChain: number;
    toChain: number;
    fromToken: string;
    toToken: string;
    estimatedFeeUSD: number;
    estimatedTimeMs: number;
    protocol?: string;
}

export interface RouteFindingConfig {
    /** Maximum time to wait for all queries in ms */
    timeoutMs: number;
    /** Number of top routes to return */
    maxRoutes: number;
    /** Whether to include swap routes */
    includeSwaps: boolean;
    /** Whether to include bridge routes */
    includeBridges: boolean;
    /** Maximum number of hops allowed */
    maxHops: number;
    /** Prefer speed over cost (0-1) */
    speedPreference: number;
}

export interface ChainClient {
    getChainId(): number;
    getChainName(): string;
    getBalance(address: string, token?: string): Promise<bigint>;
    getTokenPriceUSD(token: string): Promise<number>;
    estimateTransferFee(to: string, amount: string, token: string): Promise<bigint>;
}

export interface RouteFindingResult {
    routes: RouteCandidate[];
    balances: ChainBalance[];
    queryTimeMs: number;
    timedOut: boolean;
    errors: Array<{ chain: number; error: string }>;
}

const DEFAULT_CONFIG: RouteFindingConfig = {
    timeoutMs: 5000,
    maxRoutes: 5,
    includeSwaps: true,
    includeBridges: true,
    maxHops: 3,
    speedPreference: 0.5,
};

// Cache for balance queries
interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

export class ParallelRouteFinder {
    private clients: Map<number, ChainClient> = new Map();
    private config: RouteFindingConfig;
    private balanceCache: Map<string, CacheEntry<ChainBalance>> = new Map();
    private readonly CACHE_TTL_MS = 10000; // 10 seconds

    constructor(
        clients: ChainClient[],
        config: Partial<RouteFindingConfig> = {}
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        for (const client of clients) {
            this.clients.set(client.getChainId(), client);
        }
    }

    /**
     * Add a chain client.
     */
    addClient(client: ChainClient): void {
        this.clients.set(client.getChainId(), client);
    }

    /**
     * Remove a chain client.
     */
    removeClient(chainId: number): boolean {
        return this.clients.delete(chainId);
    }

    /**
     * Find optimal routes for a payment.
     */
    async findRoutes(
        address: string,
        targetChain: number,
        targetToken: string,
        amountUSD: number,
        options: Partial<RouteFindingConfig> = {}
    ): Promise<RouteFindingResult> {
        const config = { ...this.config, ...options };
        const startTime = Date.now();
        const errors: Array<{ chain: number; error: string }> = [];

        // Create timeout promise
        const timeoutPromise = new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), config.timeoutMs)
        );

        // Query all balances in parallel
        const balancePromises = Array.from(this.clients.entries()).map(
            async ([chainId, client]): Promise<ChainBalance | null> => {
                // Check cache first
                const cacheKey = `${address}:${chainId}:${targetToken}`;
                const cached = this.balanceCache.get(cacheKey);
                if (cached && cached.expiresAt > Date.now()) {
                    return cached.value;
                }

                try {
                    const [balance, priceUSD] = await Promise.all([
                        client.getBalance(address, targetToken),
                        client.getTokenPriceUSD(targetToken),
                    ]);

                    const result: ChainBalance = {
                        chain: chainId,
                        chainName: client.getChainName(),
                        token: targetToken,
                        balance,
                        balanceUSD: Number(balance) * priceUSD / 1e6, // Assuming 6 decimals
                    };

                    // Cache the result
                    this.balanceCache.set(cacheKey, {
                        value: result,
                        expiresAt: Date.now() + this.CACHE_TTL_MS,
                    });

                    return result;
                } catch (error) {
                    errors.push({
                        chain: chainId,
                        error: error instanceof Error ? error.message : 'Unknown error',
                    });
                    return null;
                }
            }
        );

        // Race against timeout
        const balanceResults = await Promise.race([
            Promise.all(balancePromises),
            timeoutPromise,
        ]);

        let timedOut = false;
        let balances: ChainBalance[];

        if (balanceResults === 'timeout') {
            timedOut = true;
            // Get whatever results we have so far
            balances = [];
            for (const [chainId] of this.clients) {
                const cacheKey = `${address}:${chainId}:${targetToken}`;
                const cached = this.balanceCache.get(cacheKey);
                if (cached) {
                    balances.push(cached.value);
                }
            }
        } else {
            balances = balanceResults.filter((b): b is ChainBalance => b !== null);
        }

        // Find candidate routes
        const routes = await this.generateRoutes(
            balances,
            targetChain,
            targetToken,
            amountUSD,
            config
        );

        // Sort routes by score (lower is better)
        routes.sort((a, b) => a.score - b.score);

        return {
            routes: routes.slice(0, config.maxRoutes),
            balances,
            queryTimeMs: Date.now() - startTime,
            timedOut,
            errors,
        };
    }

    /**
     * Generate candidate routes from available balances.
     */
    private async generateRoutes(
        balances: ChainBalance[],
        targetChain: number,
        targetToken: string,
        amountUSD: number,
        config: RouteFindingConfig
    ): Promise<RouteCandidate[]> {
        const routes: RouteCandidate[] = [];

        // Filter balances with sufficient funds
        const sufficientBalances = balances.filter(b => b.balanceUSD >= amountUSD);

        for (const balance of sufficientBalances) {
            // Direct transfer (same chain)
            if (balance.chain === targetChain) {
                const route = await this.createDirectRoute(
                    balance,
                    targetChain,
                    targetToken,
                    amountUSD,
                    config
                );
                if (route) routes.push(route);
            }
            // Bridge route (cross-chain)
            else if (config.includeBridges) {
                const route = await this.createBridgeRoute(
                    balance,
                    targetChain,
                    targetToken,
                    amountUSD,
                    config
                );
                if (route) routes.push(route);
            }
        }

        return routes;
    }

    /**
     * Create a direct transfer route.
     */
    private async createDirectRoute(
        balance: ChainBalance,
        targetChain: number,
        targetToken: string,
        amountUSD: number,
        config: RouteFindingConfig
    ): Promise<RouteCandidate | null> {
        const client = this.clients.get(balance.chain);
        if (!client) return null;

        try {
            // Estimate transfer fee
            const fee = await client.estimateTransferFee(
                '0x0000000000000000000000000000000000000000', // Placeholder recipient
                String(BigInt(Math.floor(amountUSD * 1e6))),
                targetToken
            );

            const feeUSD = Number(fee) / 1e18 * 2000; // Rough ETH to USD conversion

            const hop: RouteHop = {
                type: 'transfer',
                fromChain: balance.chain,
                toChain: targetChain,
                fromToken: targetToken,
                toToken: targetToken,
                estimatedFeeUSD: feeUSD,
                estimatedTimeMs: balance.chain === 1 ? 15000 : 2000, // L1 vs L2
            };

            return {
                id: `direct_${balance.chain}_${targetChain}`,
                sourceChain: balance.chain,
                targetChain,
                sourceToken: targetToken,
                targetToken,
                estimatedFeeUSD: feeUSD,
                estimatedTimeMs: hop.estimatedTimeMs,
                hops: [hop],
                score: this.calculateScore(feeUSD, hop.estimatedTimeMs, config),
            };
        } catch {
            return null;
        }
    }

    /**
     * Create a bridge route.
     */
    private async createBridgeRoute(
        balance: ChainBalance,
        targetChain: number,
        targetToken: string,
        amountUSD: number,
        config: RouteFindingConfig
    ): Promise<RouteCandidate | null> {
        // Estimate bridge parameters
        const bridgeFeeUSD = 2.5; // Typical Wormhole fee
        const bridgeTimeMs = 180000; // 3 minutes typical

        const hops: RouteHop[] = [
            {
                type: 'bridge',
                fromChain: balance.chain,
                toChain: targetChain,
                fromToken: targetToken,
                toToken: targetToken,
                estimatedFeeUSD: bridgeFeeUSD,
                estimatedTimeMs: bridgeTimeMs,
                protocol: 'wormhole',
            },
        ];

        const totalFeeUSD = hops.reduce((sum, h) => sum + h.estimatedFeeUSD, 0);
        const totalTimeMs = hops.reduce((sum, h) => sum + h.estimatedTimeMs, 0);

        return {
            id: `bridge_${balance.chain}_${targetChain}`,
            sourceChain: balance.chain,
            targetChain,
            sourceToken: targetToken,
            targetToken,
            estimatedFeeUSD: totalFeeUSD,
            estimatedTimeMs: totalTimeMs,
            hops,
            score: this.calculateScore(totalFeeUSD, totalTimeMs, config),
        };
    }

    /**
     * Calculate route score (lower is better).
     */
    private calculateScore(
        feeUSD: number,
        timeMs: number,
        config: RouteFindingConfig
    ): number {
        // Normalize fee (assume max fee of $10)
        const normalizedFee = Math.min(feeUSD / 10, 1);

        // Normalize time (assume max time of 5 minutes)
        const normalizedTime = Math.min(timeMs / (5 * 60 * 1000), 1);

        // Weighted score based on preference
        const costWeight = 1 - config.speedPreference;
        const speedWeight = config.speedPreference;

        return normalizedFee * costWeight + normalizedTime * speedWeight;
    }

    /**
     * Get all chain balances in parallel.
     */
    async getAllBalances(
        address: string,
        tokens: string[] = ['USDC']
    ): Promise<ChainBalance[]> {
        const promises: Promise<ChainBalance | null>[] = [];

        for (const [chainId, client] of this.clients) {
            for (const token of tokens) {
                promises.push(
                    (async () => {
                        try {
                            const [balance, priceUSD] = await Promise.all([
                                client.getBalance(address, token),
                                client.getTokenPriceUSD(token),
                            ]);

                            return {
                                chain: chainId,
                                chainName: client.getChainName(),
                                token,
                                balance,
                                balanceUSD: Number(balance) * priceUSD / 1e6,
                            };
                        } catch {
                            return null;
                        }
                    })()
                );
            }
        }

        const results = await Promise.all(promises);
        return results.filter((r): r is ChainBalance => r !== null);
    }

    /**
     * Clear balance cache.
     */
    clearCache(): void {
        this.balanceCache.clear();
    }

    /**
     * Get cache statistics.
     */
    getCacheStats(): { size: number; hitRate: number } {
        return {
            size: this.balanceCache.size,
            hitRate: 0, // Would need to track hits/misses
        };
    }
}
