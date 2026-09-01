/**
 * @packageDocumentation
 * @module StellarChainClient
 * @description
 * Agent chain client for Stellar.
 *
 * Provides balance queries and token pricing for Stellar networks,
 * used by the x402 payment flow when an agent pays a Stellar-gated endpoint.
 *
 * Uses the Stellar Horizon REST API directly (no SDK dependency) for balance
 * queries, and the Pyth oracle for XLM/USD price feeds.
 *
 * This client is NOT registered in ChainClientFactory because Stellar does not
 * participate in the Veridex hub-and-spoke Wormhole protocol. Instantiate it
 * directly when working with Stellar x402 payments.
 *
 * @example
 * ```typescript
 * const client = new StellarChainClient({ network: 'testnet' });
 * const xlmBalance = await client.getXLMBalance('G...');
 * const usdcBalance = await client.getUSDCBalance('G...');
 * const xlmPriceUSD = await client.getNativeTokenPriceUSD();
 * ```
 */

import { PythOracle } from '../oracle/PythOracle';

// ---------------------------------------------------------------------------
// Network configuration
// ---------------------------------------------------------------------------

const HORIZON_URLS: Record<string, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  pubnet: 'https://horizon.stellar.org',
  'stellar:testnet': 'https://horizon-testnet.stellar.org',
  'stellar:pubnet': 'https://horizon.stellar.org',
};

const USDC_ISSUERS: Record<string, string> = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  pubnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  'stellar:testnet': 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  'stellar:pubnet': 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StellarChainClientConfig {
  /** Stellar network. Accepts 'testnet', 'pubnet', or CAIP-2 'stellar:testnet'. */
  network: string;
  /** Optional custom Horizon URL. Defaults to public Horizon for the network. */
  horizonUrl?: string;
  /** Request timeout in ms. Default: 10000 */
  timeoutMs?: number;
}

export interface StellarBalance {
  xlm: string;
  usdc: string;
  xlmUSD: number;
  usdcUSD: number;
}

// ---------------------------------------------------------------------------
// StellarChainClient
// ---------------------------------------------------------------------------

export class StellarChainClient {
  private horizonUrl: string;
  private usdcIssuer: string;
  private network: string;
  private timeoutMs: number;

  constructor(config: StellarChainClientConfig) {
    this.network = config.network;
    this.horizonUrl =
      config.horizonUrl ||
      HORIZON_URLS[config.network] ||
      HORIZON_URLS.testnet;
    this.usdcIssuer =
      USDC_ISSUERS[config.network] || USDC_ISSUERS.testnet;
    this.timeoutMs = config.timeoutMs || 10000;
  }

  /**
   * Get raw XLM balance for a Stellar account (in stroops, 7 decimal places).
   * Returns '0' if the account does not exist.
   */
  async getXLMBalance(publicKey: string): Promise<string> {
    const account = await this.fetchAccount(publicKey);
    if (!account) return '0';

    const nativeEntry = (account.balances as any[]).find(
      (b: any) => b.asset_type === 'native',
    );
    if (!nativeEntry) return '0';

    // Horizon returns human-readable e.g. "100.0000000"; convert to stroops
    const xlmHuman = parseFloat(nativeEntry.balance);
    return String(Math.round(xlmHuman * 10_000_000));
  }

  /**
   * Get raw USDC balance for a Stellar account (in units with 7 decimal places).
   * Returns '0' if the account does not hold USDC or does not exist.
   */
  async getUSDCBalance(publicKey: string): Promise<string> {
    const account = await this.fetchAccount(publicKey);
    if (!account) return '0';

    const usdcEntry = (account.balances as any[]).find(
      (b: any) =>
        b.asset_type !== 'native' &&
        b.asset_code === 'USDC' &&
        b.asset_issuer === this.usdcIssuer,
    );
    if (!usdcEntry) return '0';

    const usdcHuman = parseFloat(usdcEntry.balance);
    return String(Math.round(usdcHuman * 10_000_000));
  }

  /**
   * Get both XLM and USDC balances with USD values.
   */
  async getBalance(publicKey: string): Promise<StellarBalance> {
    const [xlmRaw, usdcRaw, xlmPrice] = await Promise.all([
      this.getXLMBalance(publicKey),
      this.getUSDCBalance(publicKey),
      this.getNativeTokenPriceUSD(),
    ]);

    const xlmHuman = parseInt(xlmRaw, 10) / 10_000_000;
    const usdcHuman = parseInt(usdcRaw, 10) / 10_000_000;

    return {
      xlm: xlmRaw,
      usdc: usdcRaw,
      xlmUSD: xlmHuman * xlmPrice,
      usdcUSD: usdcHuman, // USDC is 1:1 USD
    };
  }

  /**
   * Get total balance in USD (XLM + USDC).
   */
  async getTotalBalanceUSD(publicKey: string): Promise<number> {
    const bal = await this.getBalance(publicKey);
    return bal.xlmUSD + bal.usdcUSD;
  }

  /**
   * Get the current XLM/USD price via the Pyth oracle.
   */
  async getNativeTokenPriceUSD(): Promise<number> {
    try {
      return await PythOracle.getInstance().getNativeTokenPrice('stellar');
    } catch {
      console.warn('[StellarChainClient] XLM price unavailable from Pyth, using fallback');
      return 0.1; // Conservative fallback — caller should not rely on this
    }
  }

  /**
   * Get USD price for a token.
   * USDC is always 1:1. XLM is fetched from Pyth.
   */
  async getTokenPriceUSD(token: string): Promise<number> {
    const upper = token.toUpperCase();
    if (upper.includes('USDC') || upper.includes('USDT')) return 1.0;
    if (upper === 'XLM' || upper === 'NATIVE') return this.getNativeTokenPriceUSD();
    return 1.0;
  }

  /**
   * Convert a stroops amount to human-readable (7 decimal places).
   */
  stroopsToXLM(stroops: string | number): number {
    return Number(stroops) / 10_000_000;
  }

  /**
   * Convert a human-readable XLM amount to stroops.
   */
  xlmToStroops(xlm: number): string {
    return String(Math.round(xlm * 10_000_000));
  }

  /**
   * USDC on Stellar also uses 7 decimal places.
   */
  usdcToRaw(usd: number): string {
    return String(Math.round(usd * 10_000_000));
  }

  rawToUSDC(raw: string | number): number {
    return Number(raw) / 10_000_000;
  }

  getNetwork(): string {
    return this.network;
  }

  getHorizonUrl(): string {
    return this.horizonUrl;
  }

  getUSDCIssuer(): string {
    return this.usdcIssuer;
  }

  // --------------------------------------------------------------------------

  private async fetchAccount(publicKey: string): Promise<any | null> {
    try {
      const response = await fetch(
        `${this.horizonUrl}/accounts/${publicKey}`,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Horizon ${response.status}: ${text}`);
      }
      return response.json();
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        console.warn(`[StellarChainClient] Horizon request timed out for ${publicKey}`);
        return null;
      }
      throw err;
    }
  }
}
