/**
 * @packageDocumentation
 * @module EVMFacilitatorAdapter
 * @description
 * Generic EVM facilitator adapter for x402 payment verification and settlement.
 *
 * Supports:
 * - Coinbase x402 facilitator (testnet: x402.org, mainnet: api.cdp.coinbase.com)
 * - Veridex relayer facilitator (fallback)
 * - Any HTTP-based facilitator implementing the x402 verify/settle API
 *
 * This adapter fills the gap in X402Client.settleWithFacilitator() which previously
 * only supported Cronos. It handles Base, Ethereum, and any EVM chain supported by
 * the configured facilitator.
 */

import {
  Payment402Request,
  Payment402Response,
  PaymentSettlementResponse,
} from '../../types/x402';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';

// ---------------------------------------------------------------------------
// CAIP-2 Network Mapping
// ---------------------------------------------------------------------------

/** CAIP-2 format network identifiers */
export const CAIP2_NETWORKS: Record<string, string> = {
  'base-mainnet': 'eip155:8453',
  'base': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  'ethereum-mainnet': 'eip155:1',
  'ethereum': 'eip155:1',
  'ethereum-sepolia': 'eip155:11155111',
  'optimism-mainnet': 'eip155:10',
  'optimism': 'eip155:10',
  'arbitrum-mainnet': 'eip155:42161',
  'arbitrum': 'eip155:42161',
  'polygon-mainnet': 'eip155:137',
  'polygon': 'eip155:137',
  'solana-mainnet': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

/** Reverse mapping: CAIP-2 → friendly name */
export const CAIP2_TO_NAME: Record<string, string> = {
  'eip155:8453': 'Base',
  'eip155:84532': 'Base Sepolia',
  'eip155:1': 'Ethereum',
  'eip155:11155111': 'Ethereum Sepolia',
  'eip155:10': 'Optimism',
  'eip155:42161': 'Arbitrum',
  'eip155:137': 'Polygon',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'Solana Devnet',
};

/** USDC addresses per CAIP-2 network */
export const USDC_BY_CAIP2: Record<string, string> = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'eip155:1': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'eip155:11155111': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  'eip155:10': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  'eip155:42161': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

/** USDC addresses per friendly network name (for backward compat with veridexPaywall) */
export const USDC_BY_NAME: Record<string, string> = {
  'base-mainnet': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'ethereum-mainnet': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'ethereum-sepolia': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  'optimism-mainnet': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  'arbitrum-mainnet': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a friendly network name to CAIP-2 format.
 * If already in CAIP-2 format, returns as-is.
 */
export function toCAIP2(network: string): string {
  if (network.includes(':')) return network; // Already CAIP-2
  return CAIP2_NETWORKS[network] || network;
}

/**
 * Convert CAIP-2 to friendly name.
 */
export function fromCAIP2(caip2: string): string {
  return CAIP2_TO_NAME[caip2] || caip2;
}

/**
 * Get USDC address for a network (accepts both CAIP-2 and friendly names).
 */
export function getUSDCAddress(network: string): string {
  return USDC_BY_CAIP2[network] || USDC_BY_NAME[network] || USDC_BY_CAIP2[toCAIP2(network)] || '';
}

/**
 * Convert human-readable USD amount to USDC raw units (6 decimals).
 */
export function toUSDCRaw(amount: number): string {
  return String(Math.round(amount * 1_000_000));
}

/**
 * Convert USDC raw units to human-readable.
 */
export function fromUSDCRaw(raw: string): number {
  return parseInt(raw, 10) / 1_000_000;
}

/**
 * Determine if a network is mainnet.
 */
export function isMainnet(network: string): boolean {
  const caip2 = toCAIP2(network);
  const mainnetIds = ['eip155:8453', 'eip155:1', 'eip155:10', 'eip155:42161', 'eip155:137', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'];
  return mainnetIds.includes(caip2);
}

// ---------------------------------------------------------------------------
// Facilitator URLs
// ---------------------------------------------------------------------------

/** Coinbase x402 facilitator URLs */
export const COINBASE_FACILITATOR = {
  testnet: 'https://www.x402.org/facilitator',
  mainnet: 'https://api.cdp.coinbase.com/platform/v2/x402',
} as const;

/** Veridex relayer facilitator (fallback + multi-protocol) */
export const VERIDEX_FACILITATOR = 'https://relayer.veridex.network/api/v1';

/**
 * Get the appropriate facilitator URL for a network.
 */
export function getFacilitatorUrl(network: string, customUrl?: string): string {
  if (customUrl) return customUrl;
  return isMainnet(network) ? COINBASE_FACILITATOR.mainnet : COINBASE_FACILITATOR.testnet;
}

function decodePaymentPayload(paymentPayload: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(paymentPayload, 'base64').toString('utf-8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EVMFacilitatorConfig {
  /** Network identifier (CAIP-2 or friendly name). Default: 'base-sepolia' */
  network?: string;
  /** Custom facilitator URL. If omitted, auto-selects Coinbase testnet/mainnet. */
  facilitatorUrl?: string;
  /** Fallback facilitator URL. Default: Veridex relayer. */
  fallbackFacilitatorUrl?: string;
  /** Timeout for facilitator requests in ms. Default: 15000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// EVMFacilitatorAdapter
// ---------------------------------------------------------------------------

/**
 * Generic EVM facilitator adapter for x402 payment verification and settlement.
 *
 * Works with any HTTP-based x402 facilitator (Coinbase, Veridex, custom).
 * Automatically selects testnet/mainnet Coinbase facilitator based on network.
 * Falls back to Veridex relayer if primary facilitator is unavailable.
 */
export class EVMFacilitatorAdapter {
  private facilitatorUrl: string;
  private fallbackUrl: string;
  private timeoutMs: number;
  private network: string;

  constructor(config: EVMFacilitatorConfig = {}) {
    this.network = config.network || 'base-sepolia';
    this.facilitatorUrl = config.facilitatorUrl || getFacilitatorUrl(this.network);
    this.fallbackUrl = config.fallbackFacilitatorUrl || VERIDEX_FACILITATOR;
    this.timeoutMs = config.timeoutMs || 15000;
  }

  /**
   * Check if this adapter can handle a given payment request.
   * Returns true for any EVM network (eip155:*) or Solana.
   */
  canHandle(request: Payment402Request): boolean {
    const network = request.network || '';
    const caip2 = toCAIP2(network);
    return caip2.startsWith('eip155:') || caip2.startsWith('solana:') ||
      network.includes('base') || network.includes('ethereum') ||
      network.includes('optimism') || network.includes('arbitrum') ||
      network.includes('solana');
  }

  /**
   * Verify a payment proof via the facilitator.
   */
  async verify(
    request: Payment402Request,
    response: Payment402Response
  ): Promise<boolean> {
    const requirements = this.buildRequirements(request);
    const parsedPayload = decodePaymentPayload(response.paymentPayload);
    const facilitatorBody = {
      x402Version: parsedPayload.x402Version ?? 2,
      paymentPayload: parsedPayload,
      paymentPayloadBase64: response.paymentPayload,
      paymentRequirements: [requirements],
      paymentRequirement: requirements,
    };

    // Try primary facilitator
    try {
      const result = await this.callFacilitator(
        `${this.facilitatorUrl}/verify`,
        facilitatorBody
      );
      if (result && typeof result.isValid === 'boolean') {
        return result.isValid;
      }
    } catch (err: any) {
      console.warn(`[EVMFacilitator] Primary verify failed: ${err.message}`);
    }

    // Try fallback
    try {
      const result = await this.callFacilitator(
        `${this.fallbackUrl}/verify`,
        facilitatorBody
      );
      if (result && typeof result.isValid === 'boolean') {
        return result.isValid;
      }
    } catch (err: any) {
      console.warn(`[EVMFacilitator] Fallback verify failed: ${err.message}`);
    }

    return false;
  }

  /**
   * Settle a verified payment via the facilitator.
   */
  async settle(
    request: Payment402Request,
    response: Payment402Response
  ): Promise<PaymentSettlementResponse> {
    const requirements = this.buildRequirements(request);
    const parsedPayload = decodePaymentPayload(response.paymentPayload);
    const facilitatorBody = {
      protocol: 'x402',
      x402Version: parsedPayload.x402Version ?? 2,
      paymentPayload: parsedPayload,
      paymentPayloadBase64: response.paymentPayload,
      paymentRequirements: [requirements],
      paymentRequirement: requirements,
    };

    // Try primary facilitator
    try {
      const result = await this.callFacilitator(
        `${this.facilitatorUrl}/settle`,
        facilitatorBody
      );
      if (result) {
        return {
          success: true,
          transactionHash: result.txHash || result.transactionHash,
          network: request.network,
          amount: request.amount,
        };
      }
    } catch (err: any) {
      console.warn(`[EVMFacilitator] Primary settle failed: ${err.message}`);
    }

    // Try fallback
    try {
      const result = await this.callFacilitator(
        `${this.fallbackUrl}/settle`,
        facilitatorBody
      );
      if (result) {
        return {
          success: true,
          transactionHash: result.txHash || result.transactionHash,
          network: request.network,
          amount: request.amount,
        };
      }
    } catch (err: any) {
      console.warn(`[EVMFacilitator] Fallback settle failed: ${err.message}`);
    }

    throw new AgentPaymentError(
      AgentPaymentErrorCode.PAYMENT_FAILED,
      'Settlement failed on all facilitators',
      'Check network connectivity and facilitator availability.',
      true
    );
  }

  /**
   * Build payment requirements object for facilitator API calls.
   */
  private buildRequirements(request: Payment402Request) {
    const caip2Network = toCAIP2(request.network);
    return {
      x402Version: 2,
      scheme: request.scheme || 'exact',
      network: caip2Network,
      maxAmountRequired: request.amount,
      asset: request.token || getUSDCAddress(caip2Network),
      payTo: request.recipient,
    };
  }

  /**
   * Make an HTTP call to a facilitator endpoint.
   */
  private async callFacilitator(url: string, body: Record<string, any>): Promise<any> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Facilitator ${response.status}: ${text}`);
    }

    return response.json();
  }
}

// ---------------------------------------------------------------------------
// Standalone verify/settle functions
// ---------------------------------------------------------------------------

/**
 * Standalone x402 payment verification.
 *
 * Use this when you need to verify a payment outside of the middleware flow
 * (e.g., in a Next.js App Router route handler).
 *
 * @param paymentPayload - Base64-encoded payment payload from PAYMENT-SIGNATURE header
 * @param requirements - Payment requirements (amount, recipient, network, asset)
 * @param options - Optional facilitator configuration
 * @returns Verification result
 */
export async function verifyX402Payment(
  paymentPayload: string,
  requirements: {
    scheme?: string;
    network: string;
    maxAmountRequired: string;
    asset: string;
    payTo: string;
  },
  options?: { facilitatorUrl?: string; fallbackUrl?: string; timeoutMs?: number }
): Promise<{ isValid: boolean; error?: string }> {
  const adapter = new EVMFacilitatorAdapter({
    network: requirements.network,
    facilitatorUrl: options?.facilitatorUrl,
    fallbackFacilitatorUrl: options?.fallbackUrl,
    timeoutMs: options?.timeoutMs,
  });

  try {
    const isValid = await adapter.verify(
      {
        amount: requirements.maxAmountRequired,
        token: requirements.asset,
        recipient: requirements.payTo,
        chain: 0,
        network: requirements.network,
        scheme: (requirements.scheme as any) || 'exact',
        original: requirements as any,
      },
      { signature: '', nonce: '', deadline: 0, paymentPayload }
    );
    return { isValid };
  } catch (err: any) {
    return { isValid: false, error: err.message };
  }
}

/**
 * Standalone x402 payment settlement.
 *
 * Use this when you need to settle a payment outside of the middleware flow.
 *
 * @param paymentPayload - Base64-encoded payment payload
 * @param requirements - Payment requirements
 * @param options - Optional facilitator configuration
 * @returns Settlement result
 */
export async function settleX402Payment(
  paymentPayload: string,
  requirements: {
    scheme?: string;
    network: string;
    maxAmountRequired: string;
    asset: string;
    payTo: string;
  },
  options?: { facilitatorUrl?: string; fallbackUrl?: string; timeoutMs?: number }
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const adapter = new EVMFacilitatorAdapter({
    network: requirements.network,
    facilitatorUrl: options?.facilitatorUrl,
    fallbackFacilitatorUrl: options?.fallbackUrl,
    timeoutMs: options?.timeoutMs,
  });

  try {
    const result = await adapter.settle(
      {
        amount: requirements.maxAmountRequired,
        token: requirements.asset,
        recipient: requirements.payTo,
        chain: 0,
        network: requirements.network,
        scheme: (requirements.scheme as any) || 'exact',
        original: requirements as any,
      },
      { signature: '', nonce: '', deadline: 0, paymentPayload }
    );
    return { success: result.success, txHash: result.transactionHash };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Build x402 payment requirements for a paywall.
 *
 * Convenience function that handles CAIP-2 conversion and USDC address lookup.
 *
 * @param params - Paywall parameters
 * @returns Payment requirements object ready for 402 response headers
 */
export function buildPaymentRequirements(params: {
  price: number;
  recipientAddress: string;
  network?: string;
  description?: string;
  facilitatorUrl?: string;
  extra?: Record<string, unknown>;
}) {
  const network = params.network || 'base-sepolia';
  const caip2 = toCAIP2(network);
  const asset = getUSDCAddress(caip2) || getUSDCAddress(network);

  return {
    scheme: 'exact' as const,
    network: caip2,
    maxAmountRequired: toUSDCRaw(params.price),
    asset,
    payTo: params.recipientAddress,
    facilitator: params.facilitatorUrl || getFacilitatorUrl(network),
    description: params.description || 'Content access payment',
    extra: params.extra,
  };
}
