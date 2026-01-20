/**
 * DEX Integration - Token Swapping & Cross-Chain Aggregation
 * 
 * Provides DEX aggregator integration for token swapping and
 * cross-chain route finding (Swap -> Bridge -> Swap).
 * Supports CCTP for native USDC transfers.
 * 
 * NOTE: All chain IDs in this module are Wormhole Chain IDs by default.
 */

export interface SwapQuote {
    id: string;
    protocol: string;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    priceImpact: number;
    estimatedGasUSD: number;
    route: SwapHop[];
    expiresAt: number;
}

export interface SwapHop {
    protocol: string;
    poolAddress: string;
    fromToken: string;
    toToken: string;
    fee: number;
}

export interface CrossChainQuote {
    id: string;
    sourceChain: number;
    targetChain: number;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    estimatedToAmount: string;
    routings: {
        sourceSwap?: SwapQuote;
        bridge: {
            protocol: 'wormhole' | 'cctp';
            token: string;
            amount: string;
            feeUSD: number;
            estimatedTimeSeconds: number;
        };
        targetSwap?: SwapQuote;
    };
    totalFeeUSD: number;
    estimatedTimeSeconds: number;
}

export interface SwapResult {
    txHash: string;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    toAmount: string;
    status: 'pending' | 'confirmed' | 'failed';
    gasUsed?: string;
}

export interface DEXConfig {
    /** Maximum slippage in basis points (default: 50 = 0.5%) */
    maxSlippageBps: number;
    /** Deadline for swap in seconds (default: 300 = 5 minutes) */
    deadlineSeconds: number;
    /** Preferred protocols in order of preference */
    preferredProtocols: string[];
    /** Chains enabled for swapping (Wormhole IDs) */
    enabledChains: number[];
}

export interface TokenInfo {
    address: string;
    symbol: string;
    decimals: number;
    chainId: number;
}

const DEFAULT_CONFIG: DEXConfig = {
    maxSlippageBps: 50, // 0.5%
    deadlineSeconds: 300, // 5 minutes
    preferredProtocols: ['uniswap_v3', 'jupiter', 'curve', 'uniswap_v2'],
    enabledChains: [1, 2, 5, 6, 23, 24, 30], // Sol, Eth, Poly, Avax, Arb, Op, Base
};

// Common token addresses by Wormhole Chain ID
export const COMMON_TOKENS: Record<number, Record<string, string>> = {
    2: { // Ethereum
        USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    },
    30: { // Base
        USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        WETH: '0x4200000000000000000000000000000000000006',
    },
    1: { // Solana
        USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Native USDC
        SOL: 'So11111111111111111111111111111111111111112',
    },
    23: { // Arbitrum
        USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    },
    24: { // Optimism
        USDC: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', // Bridged (Standard)
        USDC_NATIVE: '0x0b2C639c533813f4Aa9D7837CAf992c92bdE5162', // Native
        WETH: '0x4200000000000000000000000000000000000006',
    },
    5: { // Polygon
        USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // Bridged
        USDC_NATIVE: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    },
};

// Map chain IDs to CCTP Domain presence (Wormhole IDs)
export const CCTP_SUPPORTED_CHAINS = [1, 2, 5, 23, 24, 30, 21, 6]; // Sol, Eth, Poly, Arb, Op, Base, Sui, Avax

export class DEXAggregator {
    private config: DEXConfig;
    private quoteCache: Map<string, { quote: SwapQuote; expiresAt: number }> = new Map();

    constructor(config: Partial<DEXConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Get best swap quote for a single chain.
     */
    async getBestQuote(
        chainId: number,
        fromToken: string,
        toToken: string,
        amount: string
    ): Promise<SwapQuote | null> {
        if (this.areAddressesEqual(chainId, fromToken, toToken)) return null; // No swap needed

        const quotes = await this.getQuotes(chainId, fromToken, toToken, amount);
        return quotes.length > 0 ? quotes[0] : null;
    }

    /**
     * Get swap quotes from multiple protocols.
     */
    async getQuotes(
        chainId: number,
        fromToken: string,
        toToken: string,
        amount: string
    ): Promise<SwapQuote[]> {
        // Allow enabled chains
        if (!this.config.enabledChains.includes(chainId)) {
            // throw new Error(`Chain ${chainId} not enabled for swapping`);
            return [];
        }

        // Use cache if valid
        const cacheKey = `${chainId}:${fromToken}:${toToken}:${amount}`;
        const cached = this.quoteCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return [cached.quote];
        }

        // In a real implementation, we would query 1inch, ParaSwap, Jupiter (Solana), etc.
        // Here we simulate a quote request
        const simulatedQuote = await this.simulateQuote(chainId, fromToken, toToken, amount);
        if (simulatedQuote) {
            this.quoteCache.set(cacheKey, {
                quote: simulatedQuote,
                expiresAt: Date.now() + 15000 // 15s cache
            });
            return [simulatedQuote];
        }

        return [];
    }

    /**
     * Find optimized cross-chain route including swaps.
     * Supports CCTP and standard bridging.
     */
    async findCrossChainRoute(
        sourceChain: number,
        sourceToken: string,
        targetChain: number,
        targetToken: string,
        amount: string
    ): Promise<CrossChainQuote | null> {
        // 1. Identify Bridge Token
        // Ideally we check common bridge tokens: USDC, ETH, SOL

        // Priority: USDC (for CCTP) > Native > Others
        const isUSDCSource = this.isUSDC(sourceChain, sourceToken);
        const isUSDCTarget = this.isUSDC(targetChain, targetToken);

        // Default to USDC-First approach if available on that chain
        let bridgeTokenSymbol = 'USDC';
        if (!isUSDCSource && !this.getTokenAddress(sourceChain, 'USDC')) {
            // Fallback to WETH if USDC not present
            bridgeTokenSymbol = 'WETH';
        }

        const sourceBridgeToken = this.getTokenAddress(sourceChain, bridgeTokenSymbol) || sourceToken;
        const targetBridgeToken = this.getTokenAddress(targetChain, bridgeTokenSymbol) || targetToken;

        // Step 1: Source Swap (if needed)
        let sourceSwap: SwapQuote | undefined;
        let bridgeAmount = amount;

        if (!this.areAddressesEqual(sourceChain, sourceToken, sourceBridgeToken)) {
            const quote = await this.getBestQuote(sourceChain, sourceToken, sourceBridgeToken, amount);
            if (!quote) return null; // Cannot swap to bridge token
            sourceSwap = quote;
            bridgeAmount = quote.toAmount;
        }

        // Step 2: Bridge Logic
        // If connecting to/from USDC and supported, use CCTP
        const bridgeProtocol = (bridgeTokenSymbol === 'USDC' && this.supportsCCTP(sourceChain, targetChain))
            ? 'cctp' : 'wormhole';

        // Estimate bridge fees & time
        const bridgeFee = this.estimateBridgeCost(bridgeProtocol, sourceChain, targetChain);
        const bridgeTime = this.estimateBridgeTime(bridgeProtocol, sourceChain, targetChain);

        // CCTP is burn/mint (no value loss other than gas, handled in feeUSD)
        const destBridgeAmount = bridgeAmount;

        // Step 3: Target Swap (if needed)
        let targetSwap: SwapQuote | undefined;
        let finalAmount = destBridgeAmount;

        if (!this.areAddressesEqual(targetChain, targetBridgeToken, targetToken)) {
            const quote = await this.getBestQuote(targetChain, targetBridgeToken, targetToken, destBridgeAmount);
            if (!quote) return null; // Cannot swap from bridge token
            targetSwap = quote;
            finalAmount = quote.toAmount;
        }

        const totalFeeUSD = (sourceSwap?.estimatedGasUSD || 0) +
            bridgeFee +
            (targetSwap?.estimatedGasUSD || 0);

        const totalTime = (sourceSwap ? 15 : 0) + bridgeTime + (targetSwap ? 15 : 0);

        return {
            id: `route_${Date.now()}`,
            sourceChain,
            targetChain,
            fromToken: sourceToken,
            toToken: targetToken,
            fromAmount: amount,
            estimatedToAmount: finalAmount,
            routings: {
                sourceSwap,
                bridge: {
                    protocol: bridgeProtocol,
                    token: bridgeTokenSymbol,
                    amount: bridgeAmount,
                    feeUSD: bridgeFee,
                    estimatedTimeSeconds: bridgeTime
                },
                targetSwap
            },
            totalFeeUSD,
            estimatedTimeSeconds: totalTime
        };
    }

    /**
     * Check if CCTP is supported between chains.
     */
    supportsCCTP(sourceChain: number, targetChain: number): boolean {
        return CCTP_SUPPORTED_CHAINS.includes(sourceChain) &&
            CCTP_SUPPORTED_CHAINS.includes(targetChain);
    }

    /**
     * Check if token is USDC.
     */
    isUSDC(chain: number, token: string): boolean {
        const addr = this.getTokenAddress(chain, 'USDC') || this.getTokenAddress(chain, 'USDC_NATIVE');
        return addr ? this.areAddressesEqual(chain, addr, token) : false;
    }

    /**
     * Execute a swap (Simulation).
     */
    async executeSwap(
        quote: SwapQuote,
        signer: { signTransaction: (tx: unknown) => Promise<string> }
    ): Promise<SwapResult> {
        if (Date.now() > quote.expiresAt) {
            throw new Error('Quote expired');
        }

        // Simulated result
        const txHash = '0x' + Array.from({ length: 64 }, () =>
            Math.floor(Math.random() * 16).toString(16)
        ).join('');

        return {
            txHash,
            fromToken: quote.fromToken,
            toToken: quote.toToken,
            fromAmount: quote.fromAmount,
            toAmount: quote.toAmount,
            status: 'confirmed',
        };
    }

    /**
     * Get supported tokens for a chain.
     */
    getSupportedTokens(chainId: number): string[] {
        return Object.keys(COMMON_TOKENS[chainId] || {});
    }

    /**
     * Check if a swap route exists.
     */
    async hasRoute(
        chainId: number,
        fromToken: string,
        toToken: string
    ): Promise<boolean> {
        try {
            const quote = await this.getBestQuote(chainId, fromToken, toToken, '1000000');
            return quote !== null;
        } catch {
            return false;
        }
    }

    /**
     * Get estimated output for a swap.
     */
    async getEstimatedOutput(
        chainId: number,
        fromToken: string,
        toToken: string,
        amount: string
    ): Promise<{ output: string; priceImpact: number } | null> {
        const quote = await this.getBestQuote(chainId, fromToken, toToken, amount);
        if (!quote) return null;

        return {
            output: quote.toAmount,
            priceImpact: quote.priceImpact,
        };
    }

    /**
     * Clear quote cache.
     */
    clearCache(): void {
        this.quoteCache.clear();
    }

    // Helper to find common bridge token address
    getTokenAddress(chain: number, symbol: string): string | undefined {
        return COMMON_TOKENS[chain]?.[symbol];
    }

    // Private helper for address comparison handling case sensitivity
    private areAddressesEqual(chain: number, a: string, b: string): boolean {
        if (chain === 1 || chain === 21 || chain === 22) {
            // Solana, Sui, Aptos are simple strings (Native addresses are typically Case Sensitive in Base58)
            return a === b;
        }
        // EVM is case insensitive
        return a.toLowerCase() === b.toLowerCase();
    }

    // Simulation helpers
    private async simulateQuote(chain: number, from: string, to: string, amount: string): Promise<SwapQuote | null> {
        const amountBigInt = BigInt(amount);
        const slippage = this.config.maxSlippageBps / 10000;

        // Simulate price impact
        // Cap at 3%
        const priceImpact = Math.min(Number(amountBigInt) / 1e12, 0.03);

        const outputMultiplier = from === to ? 1 : 0.997; // 0.3% fee
        const toAmount = BigInt(Math.floor(Number(amountBigInt) * outputMultiplier * (1 - priceImpact)));
        const toAmountMin = BigInt(Math.floor(Number(toAmount) * (1 - slippage)));

        const protocol = (chain === 1) ? 'jupiter' : 'uniswap_v3';

        const estimatedGasUSD = (chain === 1) ? 0.001 : 0.5;

        return {
            id: `sim_quote_${Date.now()}`,
            protocol,
            fromToken: from,
            toToken: to,
            fromAmount: amount,
            toAmount: toAmount.toString(),
            toAmountMin: toAmountMin.toString(),
            priceImpact,
            estimatedGasUSD,
            route: [{
                protocol,
                poolAddress: '0x' + '0'.repeat(40),
                fromToken: from,
                toToken: to,
                fee: 3000
            }],
            expiresAt: Date.now() + 60000
        };
    }

    private estimateBridgeCost(protocol: string, source: number, dest: number): number {
        if (protocol === 'cctp') return 0.2; // CCTP is cheap
        return 1.5; // Wormhole Standard
    }

    private estimateBridgeTime(protocol: string, source: number, dest: number): number {
        if (protocol === 'cctp') return 600; // ~10-20 mins
        return 120; // Wormhole Standard
    }
}

// Singleton instance
let defaultAggregator: DEXAggregator | null = null;
export function getDEXAggregator(): DEXAggregator {
    if (!defaultAggregator) {
        defaultAggregator = new DEXAggregator();
    }
    return defaultAggregator;
}

export function createDEXAggregator(config?: Partial<DEXConfig>): DEXAggregator {
    return new DEXAggregator(config);
}
