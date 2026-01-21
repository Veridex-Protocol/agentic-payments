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
     * Get the USD price for a given feed ID.
     */
    async getPrice(feedId: string): Promise<number> {
        // Check cache
        const cached = this.cache.get(feedId);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
            return cached.price;
        }

        try {
            const cleanId = feedId.startsWith('0x') ? feedId.slice(2) : feedId;
            const response = await axios.get(`${HERMES_ENDPOINT}/v2/updates/price/latest`, {
                params: {
                    ids: [cleanId],
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
}
