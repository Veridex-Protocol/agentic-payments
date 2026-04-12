/**
 * @packageDocumentation
 * @module AvalancheChainClient
 * @description
 * Agent adapter for Avalanche C-Chain with ACP-204 P-256 + ICM Teleporter support.
 *
 * Extends EVMChainClient with Avalanche-specific features:
 * - ACP-204 native secp256r1 precompile verification (98% cheaper passkeys)
 * - Chainlink price feeds for USD-denominated agent spending limits
 * - ICM Spoke status queries for cross-L1 session verification
 * - Avalanche-specific gas estimation (sub-second finality via Snowman)
 *
 * ## Enterprise Alignment
 *
 * This client enables enterprise-grade agent payment infrastructure:
 * - **Deterministic costs**: ACP-204 has fixed 6,900 gas for P-256 verification
 * - **USD budgeting**: Chainlink feeds convert AVAX amounts to USD in real-time
 * - **Multi-L1 sessions**: ICM Spoke queries verify session validity across Avalanche L1s
 * - **Sub-second finality**: Snowman consensus provides instant payment receipts
 *
 * @example
 * ```typescript
 * import { AvalancheChainClient } from '@veridex/agentic-payments';
 *
 * const client = new AvalancheChainClient({
 *   chainId: 43113,
 *   wormholeChainId: 6,
 *   rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
 *   hubContractAddress: '0x...',
 *   wormholeCoreBridge: '0x7bbcE28e64B3F8b84d876Ab298393c38ad7aac4C',
 *   chainlinkAvaxUsdFeed: '0x5498BB86BC934c8D34FDA08E81D444153d0D06aD',
 * });
 *
 * // Get AVAX price for budget calculation
 * const avaxUsd = await client.getAvaxPriceUSD();
 *
 * // Check ICM Spoke session validity
 * const sessionValid = await client.verifyICMSession(sessionKeyHash, amount);
 *
 * // Estimate gas for a passkey verification (deterministic on Avalanche)
 * const gasCost = await client.estimatePasskeyVerificationGas();
 * ```
 */
import { EVMClient as CoreEVMClient, EVMClientConfig as CoreEVMClientConfig } from '@veridex/sdk/chains/evm';
import { BaseAgentChainClient } from './ChainClient';
import { ethers } from 'ethers';

// ============================================================================
// Chainlink Aggregator V3 ABI (minimal)
// ============================================================================

const CHAINLINK_AGGREGATOR_ABI = [
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function decimals() view returns (uint8)',
    'function description() view returns (string)',
];

// ============================================================================
// ICM Spoke ABI (minimal — for session/budget verification queries)
// ============================================================================

const ICM_SPOKE_ABI = [
    'function verifySession(bytes32 sessionKeyHash, uint256 amount) view returns (bool valid, uint256 remainingBudget)',
    'function verifyBudget(bytes32 userKeyHash, address agentAddress, uint256 amount) view returns (bool valid, uint256 dailyRemaining, uint256 totalRemaining)',
    'function getSession(bytes32 sessionKeyHash) view returns (bytes32 userKeyHash, uint256 expiry, uint256 maxValue, uint256 totalBudget, uint256 spent, bool active)',
    'function getStatus() view returns (bool paused, uint256 totalMessages, uint256 totalSessions, uint256 totalPayments)',
    'function isKeyAuthorized(bytes32 identityKeyHash, bytes32 keyHash) view returns (bool)',
];

// ============================================================================
// ACP-204 P256 Verifier ABI (minimal)
// ============================================================================

const P256_VERIFIER_ABI = [
    'function verify(bytes32 messageHash, uint256 r, uint256 s, uint256 x, uint256 y) view returns (bool valid)',
    'function verifyStrict(bytes32 messageHash, uint256 r, uint256 s, uint256 x, uint256 y) view returns (bool valid)',
    'function verifyWebAuthn(bytes authenticatorData, bytes32 clientDataJSONHash, uint256 r, uint256 s, uint256 x, uint256 y) view returns (bool valid)',
    'function isPrecompileAvailable() view returns (bool available)',
    'function computeKeyHash(uint256 x, uint256 y) view returns (bytes32)',
];

// ============================================================================
// Types
// ============================================================================

export interface AvalancheChainClientConfig extends CoreEVMClientConfig {
    /** Chainlink AVAX/USD feed address */
    chainlinkAvaxUsdFeed?: string;
    /** Chainlink USDC/USD feed address */
    chainlinkUsdcUsdFeed?: string;
    /** Chainlink USDT/USD feed address */
    chainlinkUsdtUsdFeed?: string;
    /** ACP-204 P256 verifier contract address */
    p256VerifierAddress?: string;
    /** ICM Spoke contract address (for cross-L1 queries) */
    icmSpokeAddress?: string;
}

export interface ChainlinkPrice {
    /** Price in USD (8 decimals normalized to float) */
    price: number;
    /** Round ID from Chainlink */
    roundId: bigint;
    /** Timestamp of the price update */
    updatedAt: number;
    /** Staleness: seconds since last update */
    staleness: number;
}

export interface ICMSpokeStatus {
    paused: boolean;
    totalMessages: bigint;
    totalSessions: bigint;
    totalPayments: bigint;
}

export interface ICMSessionInfo {
    userKeyHash: string;
    expiry: number;
    maxValue: bigint;
    totalBudget: bigint;
    spent: bigint;
    active: boolean;
}

// ============================================================================
// AvalancheChainClient
// ============================================================================

/**
 * Agent-specific Avalanche chain client with ACP-204 and ICM Teleporter support.
 *
 * Provides:
 * - Chainlink-powered USD price feeds for agent budget management
 * - ICM Spoke queries for cross-L1 session verification
 * - ACP-204 precompile availability checks
 * - Avalanche-optimized gas estimation
 */
export class AvalancheChainClient extends BaseAgentChainClient {
    private evmCore: CoreEVMClient;
    private provider: ethers.JsonRpcProvider;
    private chainlinkAvaxUsdFeed: string;
    private chainlinkUsdcUsdFeed: string;
    private chainlinkUsdtUsdFeed: string;
    private p256VerifierAddress: string;
    private icmSpokeAddress: string;

    // Price cache (avoid excessive RPC calls)
    private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
    private readonly CACHE_TTL_MS = 30_000; // 30 seconds

    constructor(config: AvalancheChainClientConfig) {
        const core = new CoreEVMClient(config);
        super(core);
        this.evmCore = core;
        this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
        this.chainlinkAvaxUsdFeed = config.chainlinkAvaxUsdFeed || '';
        this.chainlinkUsdcUsdFeed = config.chainlinkUsdcUsdFeed || '';
        this.chainlinkUsdtUsdFeed = config.chainlinkUsdtUsdFeed || '';
        this.p256VerifierAddress = config.p256VerifierAddress || '';
        this.icmSpokeAddress = config.icmSpokeAddress || '';
    }

    // ========================================================================
    // Chainlink Price Oracle
    // ========================================================================

    /**
     * Get the current AVAX/USD price from Chainlink.
     * Uses caching to avoid excessive RPC calls.
     */
    async getAvaxPriceUSD(): Promise<number> {
        return this.getChainlinkPrice(this.chainlinkAvaxUsdFeed, 'avax-usd');
    }

    /**
     * Get USDC/USD price from Chainlink (for stablecoin verification).
     */
    async getUsdcPriceUSD(): Promise<number> {
        if (!this.chainlinkUsdcUsdFeed) return 1.0; // Assume pegged
        return this.getChainlinkPrice(this.chainlinkUsdcUsdFeed, 'usdc-usd');
    }

    /**
     * Get USDT/USD price from Chainlink.
     */
    async getUsdtPriceUSD(): Promise<number> {
        if (!this.chainlinkUsdtUsdFeed) return 1.0; // Assume pegged
        return this.getChainlinkPrice(this.chainlinkUsdtUsdFeed, 'usdt-usd');
    }

    /**
     * Get detailed Chainlink price data including staleness information.
     * Useful for enterprise compliance: verify price freshness before executing.
     */
    async getChainlinkPriceDetailed(feedAddress: string): Promise<ChainlinkPrice> {
        if (!feedAddress) {
            throw new Error('Chainlink feed address not configured');
        }

        const aggregator = new ethers.Contract(
            feedAddress,
            CHAINLINK_AGGREGATOR_ABI,
            this.provider,
        );

        const [roundId, answer, , updatedAt] = await aggregator.latestRoundData();
        const decimals = await aggregator.decimals();

        const price = Number(answer) / (10 ** Number(decimals));
        const staleness = Math.floor(Date.now() / 1000) - Number(updatedAt);

        return {
            price,
            roundId: BigInt(roundId),
            updatedAt: Number(updatedAt),
            staleness,
        };
    }

    /**
     * Convert a USD amount to AVAX using live Chainlink prices.
     * Essential for agents: "I have a $5/day budget — how much AVAX is that?"
     *
     * @param usdAmount The USD amount to convert
     * @returns The equivalent AVAX amount (in wei as bigint)
     */
    async convertUsdToAvax(usdAmount: number): Promise<bigint> {
        const avaxPrice = await this.getAvaxPriceUSD();
        if (avaxPrice <= 0) {
            throw new Error('Invalid AVAX price from Chainlink');
        }
        const avaxAmount = usdAmount / avaxPrice;
        // Convert to wei (18 decimals)
        return ethers.parseEther(avaxAmount.toFixed(18));
    }

    /**
     * Convert an AVAX amount (in wei) to USD using live Chainlink prices.
     */
    async convertAvaxToUsd(avaxWei: bigint): Promise<number> {
        const avaxPrice = await this.getAvaxPriceUSD();
        const avaxAmount = Number(ethers.formatEther(avaxWei));
        return avaxAmount * avaxPrice;
    }

    /**
     * Override: Use Chainlink for native token price instead of Pyth.
     * Chainlink has established Avalanche C-Chain feeds; more reliable for on-chain pricing.
     */
    async getNativeTokenPriceUSD(): Promise<number> {
        try {
            if (this.chainlinkAvaxUsdFeed) {
                return await this.getAvaxPriceUSD();
            }
        } catch {
            // Fall through to parent (Pyth) if Chainlink fails
        }
        return super.getNativeTokenPriceUSD();
    }

    // ========================================================================
    // ICM Spoke Queries (Cross-L1 Session Verification)
    // ========================================================================

    /**
     * Verify a session is valid on the ICM Spoke.
     * This is the key function for cross-L1 agent payments:
     * Agent on Kite AI L1 checks if its session (created on C-Chain Hub) is still valid.
     */
    async verifyICMSession(
        sessionKeyHash: string,
        amount: bigint,
    ): Promise<{ valid: boolean; remainingBudget: bigint }> {
        if (!this.icmSpokeAddress) {
            throw new Error('ICM Spoke address not configured');
        }

        const spoke = new ethers.Contract(
            this.icmSpokeAddress,
            ICM_SPOKE_ABI,
            this.provider,
        );

        const [valid, remainingBudget] = await spoke.verifySession(sessionKeyHash, amount);
        return { valid, remainingBudget: BigInt(remainingBudget) };
    }

    /**
     * Verify an agent budget delegation on the ICM Spoke.
     */
    async verifyICMBudget(
        userKeyHash: string,
        agentAddress: string,
        amount: bigint,
    ): Promise<{ valid: boolean; dailyRemaining: bigint; totalRemaining: bigint }> {
        if (!this.icmSpokeAddress) {
            throw new Error('ICM Spoke address not configured');
        }

        const spoke = new ethers.Contract(
            this.icmSpokeAddress,
            ICM_SPOKE_ABI,
            this.provider,
        );

        const [valid, dailyRemaining, totalRemaining] = await spoke.verifyBudget(
            userKeyHash,
            agentAddress,
            amount,
        );

        return {
            valid,
            dailyRemaining: BigInt(dailyRemaining),
            totalRemaining: BigInt(totalRemaining),
        };
    }

    /**
     * Get session details from the ICM Spoke.
     */
    async getICMSession(sessionKeyHash: string): Promise<ICMSessionInfo> {
        if (!this.icmSpokeAddress) {
            throw new Error('ICM Spoke address not configured');
        }

        const spoke = new ethers.Contract(
            this.icmSpokeAddress,
            ICM_SPOKE_ABI,
            this.provider,
        );

        const [userKeyHash, expiry, maxValue, totalBudget, spent, active] =
            await spoke.getSession(sessionKeyHash);

        return {
            userKeyHash,
            expiry: Number(expiry),
            maxValue: BigInt(maxValue),
            totalBudget: BigInt(totalBudget),
            spent: BigInt(spent),
            active,
        };
    }

    /**
     * Get the ICM Spoke health status (message count, session count, etc.).
     */
    async getICMSpokeStatus(): Promise<ICMSpokeStatus> {
        if (!this.icmSpokeAddress) {
            throw new Error('ICM Spoke address not configured');
        }

        const spoke = new ethers.Contract(
            this.icmSpokeAddress,
            ICM_SPOKE_ABI,
            this.provider,
        );

        const [paused, totalMessages, totalSessions, totalPayments] = await spoke.getStatus();

        return {
            paused,
            totalMessages: BigInt(totalMessages),
            totalSessions: BigInt(totalSessions),
            totalPayments: BigInt(totalPayments),
        };
    }

    /**
     * Check if a key is authorized for an identity on the ICM Spoke.
     */
    async isKeyAuthorizedOnSpoke(identityKeyHash: string, keyHash: string): Promise<boolean> {
        if (!this.icmSpokeAddress) return false;

        const spoke = new ethers.Contract(
            this.icmSpokeAddress,
            ICM_SPOKE_ABI,
            this.provider,
        );

        return spoke.isKeyAuthorized(identityKeyHash, keyHash);
    }

    // ========================================================================
    // ACP-204 P-256 Precompile Utilities
    // ========================================================================

    /**
     * Check if the ACP-204 precompile is available on the connected chain.
     * Useful for deployment scripts and runtime validation.
     */
    async isACP204Available(): Promise<boolean> {
        if (this.p256VerifierAddress) {
            const verifier = new ethers.Contract(
                this.p256VerifierAddress,
                P256_VERIFIER_ABI,
                this.provider,
            );
            try {
                return await verifier.isPrecompileAvailable();
            } catch {
                return false;
            }
        }

        // Direct precompile check at 0x0100
        try {
            const code = await this.provider.getCode('0x0000000000000000000000000000000000000100');
            return code !== '0x'; // Precompile has "code" (it's actually a VM opcode)
        } catch {
            return false;
        }
    }

    /**
     * Estimate the gas cost for a passkey verification on Avalanche.
     * This is deterministic: ACP-204 costs exactly 6,900 gas for the precompile call.
     *
     * @returns Estimated gas in wei
     */
    async estimatePasskeyVerificationGas(): Promise<bigint> {
        const feeData = await this.provider.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.parseUnits('25', 'gwei');

        // ACP-204: 6,900 gas for P-256 verify + ~300 gas for staticcall overhead
        const estimatedGas = 7_200n;

        return estimatedGas * gasPrice;
    }

    /**
     * Estimate the USD cost of a passkey verification.
     * Enterprise use case: "How much does each authentication cost?"
     */
    async estimatePasskeyVerificationCostUSD(): Promise<number> {
        const gasCostWei = await this.estimatePasskeyVerificationGas();
        return this.convertAvaxToUsd(gasCostWei);
    }

    // ========================================================================
    // Avalanche-Specific Gas Estimation
    // ========================================================================

    /**
     * Get the current Avalanche C-Chain base fee.
     * Avalanche uses a dynamic fee model with ~25 nAVAX minimum base fee.
     */
    async getBaseFee(): Promise<bigint> {
        const block = await this.provider.getBlock('latest');
        return block?.baseFeePerGas || ethers.parseUnits('25', 'gwei');
    }

    /**
     * Estimate total cost for a full agent payment flow:
     * 1. Passkey verification (ACP-204): ~7,200 gas
     * 2. Session validation: ~25,000 gas
     * 3. Token transfer: ~65,000 gas
     * Total: ~97,200 gas
     *
     * @returns Estimated total cost in both AVAX (wei) and USD
     */
    async estimateAgentPaymentCost(): Promise<{ avaxWei: bigint; usd: number }> {
        const feeData = await this.provider.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.parseUnits('25', 'gwei');

        // Conservative estimate for full payment flow
        const totalGas = 100_000n;
        const avaxWei = totalGas * gasPrice;
        const usd = await this.convertAvaxToUsd(avaxWei);

        return { avaxWei, usd };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Get the underlying ethers provider.
     */
    getProvider(): ethers.JsonRpcProvider {
        return this.provider;
    }

    /**
     * Get the Chainlink AVAX/USD feed address.
     */
    getChainlinkAvaxUsdFeed(): string {
        return this.chainlinkAvaxUsdFeed;
    }

    /**
     * Get the P256 Verifier contract address.
     */
    getP256VerifierAddress(): string {
        return this.p256VerifierAddress;
    }

    /**
     * Get the ICM Spoke contract address.
     */
    getICMSpokeAddress(): string {
        return this.icmSpokeAddress;
    }

    // ========================================================================
    // Private Helpers
    // ========================================================================

    private async getChainlinkPrice(feedAddress: string, cacheKey: string): Promise<number> {
        if (!feedAddress) {
            throw new Error(`Chainlink feed not configured for ${cacheKey}`);
        }

        // Check cache
        const cached = this.priceCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
            return cached.price;
        }

        const aggregator = new ethers.Contract(
            feedAddress,
            CHAINLINK_AGGREGATOR_ABI,
            this.provider,
        );

        const [, answer] = await aggregator.latestRoundData();
        const decimals = await aggregator.decimals();
        const price = Number(answer) / (10 ** Number(decimals));

        // Update cache
        this.priceCache.set(cacheKey, { price, timestamp: Date.now() });

        return price;
    }
}
