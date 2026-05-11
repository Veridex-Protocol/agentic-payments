/**
 * @packageDocumentation
 * @module PythOracle
 * @description
 * Integration with Pyth Network for real-time asset pricing.
 * 
 * Agents need to know the USD value of assets to enforce spending limits (`dailyLimitUSD`).
 * This class fetches real-time prices from Pyth's Hermes API.
 * 
 * Features:
 * - **Caching**: caches prices for 30s to respect rate limits.
 * - **Smart Fallbacks**: Maps generic chain names ("base") to specific feed IDs (ETH/USD).
 */
import axios from 'axios';
import { PYTH_FEED_IDS, CHAIN_NATIVE_FEED_MAP, STARKNET_GAS_TOKEN_IS_ETH } from './PythFeeds';
import {
    DEFAULT_MAX_CONFIDENCE_RATIO,
    DEFAULT_MAX_STALE_SECONDS,
    LowConfidenceError,
    OracleError,
    PriceQuote,
    PriceQuoteOptions,
    StalePriceError,
} from './StalePriceError';

const HERMES_ENDPOINT = 'https://hermes.pyth.network';

interface PythPrice {
    id: string;
    price: {
        price: string;
        conf: string;
        expo: number;
        publish_time: number;
    };
    ema_price: {
        price: string;
        conf: string;
        expo: number;
        publish_time: number;
    };
}

interface PriceCacheEntry {
    price: number;
    timestamp: number;
    /** Full quote for strict-path reuse. Populated when fetched via getPriceStrict. */
    quote?: PriceQuote;
}

export class PythOracle {
    private static instance: PythOracle;
    private cache: Map<string, PriceCacheEntry> = new Map();
    private readonly CACHE_TTL_MS = 30000; // 30 seconds

    private constructor() { }

    public static getInstance(): PythOracle {
        if (!PythOracle.instance) {
            PythOracle.instance = new PythOracle();
        }
        return PythOracle.instance;
    }

    /**
     * Get the USD price for a given feed ID or symbol.
     * Accepts either a hex feed ID (0x...) or a symbol name (STX, BTC, ETH, etc.)
     */
    async getPrice(feedIdOrSymbol: string): Promise<number> {
        // Resolve symbol to feed ID if needed
        const feedId = this.resolveFeedId(feedIdOrSymbol);

        // Check cache
        const cached = this.cache.get(feedId);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
            return cached.price;
        }

        try {
            const cleanId = feedId.startsWith('0x') ? feedId.slice(2) : feedId;
            const response = await axios.get(`${HERMES_ENDPOINT}/v2/updates/price/latest`, {
                params: {
                    'ids[]': cleanId,
                },
            });

            const data = response.data;
            if (data && data.parsed && data.parsed.length > 0) {
                const update = data.parsed[0] as PythPrice;
                const priceUnscaled = parseInt(update.price.price);
                const expo = update.price.expo;
                const price = priceUnscaled * Math.pow(10, expo);

                this.cache.set(feedId, {
                    price,
                    timestamp: Date.now(),
                });

                return price;
            }
        } catch (error) {
            console.warn(`[PythOracle] Failed to fetch price for ${feedId}`, error);
        }

        // Return 0 or cached legacy value if failed?
        // 0 indicates failure to caller to handle fallback
        return 0;
    }

    /**
     * Strict price fetch. Validates publish-time freshness and confidence
     * ratio. Throws `StalePriceError`, `LowConfidenceError`, or `OracleError`
     * instead of returning `0`.
     *
     * Payment-critical paths (SpendingTracker, relayer settlement, session
     * authorization) MUST use this method. The legacy `getPrice()` is
     * retained only for UI-display callers that can tolerate fallback values.
     */
    async getPriceStrict(
        feedIdOrSymbol: string,
        options: PriceQuoteOptions = {},
    ): Promise<PriceQuote> {
        const maxStaleSeconds = options.maxStaleSeconds ?? DEFAULT_MAX_STALE_SECONDS;
        const maxConfidenceRatio =
            options.maxConfidenceRatio ?? DEFAULT_MAX_CONFIDENCE_RATIO;

        const feedId = this.resolveFeedId(feedIdOrSymbol);

        // Cache hit only if the cached quote itself is still within the
        // *caller's* staleness bound. A 30s local TTL is not sufficient if
        // the caller demanded maxStaleSeconds=5.
        if (!options.forceFresh) {
            const cached = this.cache.get(feedId);
            if (cached?.quote) {
                const ageSeconds = (Date.now() - cached.quote.publishTime * 1000) / 1000;
                if (ageSeconds <= maxStaleSeconds) {
                    return cached.quote;
                }
            }
        }

        const cleanId = feedId.startsWith('0x') ? feedId.slice(2) : feedId;
        let response;
        try {
            response = await axios.get(`${HERMES_ENDPOINT}/v2/updates/price/latest`, {
                params: { 'ids[]': cleanId },
                timeout: 5000,
            });
        } catch (err) {
            throw new OracleError(
                'ORACLE_UNAVAILABLE',
                `Hermes request failed for feed ${feedId}: ${(err as Error).message}`,
                { feedId, cause: (err as Error).message },
            );
        }

        const data = response.data;
        if (!data?.parsed?.length) {
            throw new OracleError(
                'ORACLE_UNKNOWN_FEED',
                `Hermes returned no price for feed ${feedId}`,
                { feedId },
            );
        }

        const update = data.parsed[0] as PythPrice;
        const priceUnscaled = parseInt(update.price.price);
        const confUnscaled = parseInt(update.price.conf);
        const expo = update.price.expo;
        const scale = Math.pow(10, expo);
        const price = priceUnscaled * scale;
        const confidence = confUnscaled * scale;
        const publishTime = update.price.publish_time;

        // Staleness guard (hard revert — cannot be disabled).
        const ageSeconds = Date.now() / 1000 - publishTime;
        if (ageSeconds > maxStaleSeconds) {
            throw new StalePriceError(feedId, publishTime, ageSeconds, maxStaleSeconds);
        }

        // Confidence guard. Skip for zero/negative prices which are themselves
        // a pathological signal handled below.
        if (price <= 0) {
            throw new OracleError(
                'ORACLE_LOW_CONFIDENCE',
                `Non-positive price ${price} for feed ${feedId}`,
                { feedId, price },
            );
        }
        const ratio = confidence / price;
        if (ratio > maxConfidenceRatio) {
            throw new LowConfidenceError(feedId, price, confidence, ratio, maxConfidenceRatio);
        }

        const quote: PriceQuote = {
            feedId,
            price,
            confidence,
            publishTime,
            fetchedAt: Date.now(),
        };
        this.cache.set(feedId, { price, timestamp: Date.now(), quote });
        return quote;
    }

    /**
     * Strict native-token fetch. Throws on unknown chains instead of returning 0.
     */
    async getNativeTokenPriceStrict(
        chainName: string,
        options: PriceQuoteOptions = {},
    ): Promise<PriceQuote> {
        let feedId = CHAIN_NATIVE_FEED_MAP[chainName];
        if (chainName === 'starknet' && STARKNET_GAS_TOKEN_IS_ETH) {
            feedId = PYTH_FEED_IDS.ETH;
        }
        if (!feedId) {
            if (
                chainName.includes('optimism') ||
                chainName.includes('arbitrum') ||
                chainName.includes('base')
            ) {
                feedId = PYTH_FEED_IDS.ETH;
            }
        }
        if (!feedId) {
            throw new OracleError(
                'ORACLE_UNKNOWN_FEED',
                `No Pyth feed mapped for chain ${chainName}`,
                { chainName },
            );
        }
        return this.getPriceStrict(feedId, options);
    }

    /**
     * Get the native token price for a specific chain.
     */
    async getNativeTokenPrice(chainName: string): Promise<number> {
        let feedId = CHAIN_NATIVE_FEED_MAP[chainName];

        // Specific handling for chains
        if (chainName === 'starknet' && STARKNET_GAS_TOKEN_IS_ETH) {
            feedId = PYTH_FEED_IDS.ETH;
        }

        // If not found in map (e.g. unknown chain), generic fallback
        if (!feedId) {
            // Check if it's an EVM L2 needing ETH
            if (chainName.includes('optimism') || chainName.includes('arbitrum') || chainName.includes('base')) {
                feedId = PYTH_FEED_IDS.ETH;
            }
        }

        if (!feedId) {
            console.warn(`[PythOracle] No native feed ID found for chain ${chainName}`);
            return 0;
        }

        return this.getPrice(feedId);
    }

    /**
     * Resolve a symbol name (STX, BTC, ETH) or feed ID to a canonical Pyth feed ID.
     */
    private resolveFeedId(feedIdOrSymbol: string): string {
        // Already a hex feed ID
        if (feedIdOrSymbol.startsWith('0x') && feedIdOrSymbol.length > 10) {
            return feedIdOrSymbol;
        }

        // Try symbol lookup
        const symbol = feedIdOrSymbol.toUpperCase() as keyof typeof PYTH_FEED_IDS;
        if (PYTH_FEED_IDS[symbol]) {
            return PYTH_FEED_IDS[symbol];
        }

        // Try chain name lookup
        const chainFeed = CHAIN_NATIVE_FEED_MAP[feedIdOrSymbol];
        if (chainFeed) {
            return chainFeed;
        }

        // Return as-is (will likely fail at Hermes, but let the caller handle it)
        return feedIdOrSymbol;
    }
}
