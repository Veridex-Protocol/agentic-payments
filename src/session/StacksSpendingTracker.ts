/**
 * @packageDocumentation
 * @module StacksSpendingTracker
 * @description
 * Stacks-specific spending tracker with real-time STX/sBTC → USD conversion.
 *
 * Uses Pyth Network oracle for price feeds:
 * - STX/USD for native STX transfers
 * - BTC/USD for sBTC transfers (sBTC is pegged 1:1 to BTC)
 *
 * Denomination:
 * - 1 STX = 1,000,000 microSTX
 * - 1 sBTC = 100,000,000 satoshis
 */
import { PythOracle } from '../oracle/PythOracle';

/** STX denomination: 1 STX = 1,000,000 microSTX */
const MICRO_STX_PER_STX = 1_000_000;

/** sBTC denomination: 1 sBTC = 100,000,000 satoshis */
const SATS_PER_SBTC = 100_000_000;

/** Default fallback prices when oracle is unavailable */
const FALLBACK_PRICES = {
    STX_USD: 0.50,
    BTC_USD: 60000,
} as const;

/**
 * Stacks-specific spending tracker for STX and sBTC → USD conversion.
 */
export class StacksSpendingTracker {
    private oracle: PythOracle;

    constructor() {
        this.oracle = PythOracle.getInstance();
    }

    /**
     * Convert microSTX amount to USD value.
     *
     * @param microSTX - Amount in microSTX (1 STX = 1,000,000 microSTX)
     * @returns USD value
     */
    async stxToUSD(microSTX: bigint): Promise<number> {
        const stxPrice = await this.getSTXPrice();
        const stxAmount = Number(microSTX) / MICRO_STX_PER_STX;
        return stxAmount * stxPrice;
    }

    /**
     * Convert sBTC satoshi amount to USD value.
     *
     * @param satoshis - Amount in satoshis (1 sBTC = 100,000,000 satoshis)
     * @returns USD value
     */
    async sbtcToUSD(satoshis: bigint): Promise<number> {
        const btcPrice = await this.getBTCPrice();
        const btcAmount = Number(satoshis) / SATS_PER_SBTC;
        return btcAmount * btcPrice;
    }

    /**
     * Convert USD amount to microSTX.
     *
     * @param usd - USD amount
     * @returns Amount in microSTX
     */
    async usdToMicroSTX(usd: number): Promise<bigint> {
        const stxPrice = await this.getSTXPrice();
        const stxAmount = usd / stxPrice;
        return BigInt(Math.floor(stxAmount * MICRO_STX_PER_STX));
    }

    /**
     * Convert USD amount to sBTC satoshis.
     *
     * @param usd - USD amount
     * @returns Amount in satoshis
     */
    async usdToSatoshis(usd: number): Promise<bigint> {
        const btcPrice = await this.getBTCPrice();
        const btcAmount = usd / btcPrice;
        return BigInt(Math.floor(btcAmount * SATS_PER_SBTC));
    }

    /**
     * Estimate USD value of a Stacks payment request.
     *
     * @param amount - Amount string in base units (microSTX or satoshis)
     * @param asset - Asset type: 'STX' or 'sBTC'/'SBTC'
     * @returns USD value
     */
    async estimatePaymentUSD(amount: string, asset: string): Promise<number> {
        const amountBig = BigInt(amount);
        const normalizedAsset = asset.toUpperCase();

        if (normalizedAsset === 'STX') {
            return this.stxToUSD(amountBig);
        }
        if (normalizedAsset === 'SBTC' || normalizedAsset === 'sBTC') {
            return this.sbtcToUSD(amountBig);
        }

        console.warn(`[StacksSpendingTracker] Unknown asset "${asset}", returning $0.`);
        return 0;
    }

    /**
     * Get the current STX/USD price from Pyth oracle.
     */
    private async getSTXPrice(): Promise<number> {
        try {
            const price = await this.oracle.getPrice('STX');
            if (price > 0) return price;
        } catch {
            // Fall through to fallback
        }
        console.warn('[StacksSpendingTracker] Using fallback STX price.');
        return FALLBACK_PRICES.STX_USD;
    }

    /**
     * Get the current BTC/USD price from Pyth oracle.
     */
    private async getBTCPrice(): Promise<number> {
        try {
            const price = await this.oracle.getPrice('BTC');
            if (price > 0) return price;
        } catch {
            // Fall through to fallback
        }
        console.warn('[StacksSpendingTracker] Using fallback BTC price.');
        return FALLBACK_PRICES.BTC_USD;
    }
}
