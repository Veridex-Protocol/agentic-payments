/**
 * @packageDocumentation
 * @module StellarFacilitatorAdapter
 * @description
 * Adapter for the Veridex Stellar x402 facilitator.
 *
 * Connects agentic-payments to the stellar-facilitator service, enabling
 * agents to pay Stellar-gated endpoints and merchants to verify/settle
 * Stellar x402 payments via the veridex/stellar-facilitator HTTP API.
 *
 * Supports both `exact` and `upto` Stellar schemes.
 * CAIP-2 network identifiers: `stellar:testnet`, `stellar:pubnet`.
 */

import type {
  Payment402Request,
  Payment402Response,
  PaymentSettlementResponse,
} from '../../types/x402';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';

// ---------------------------------------------------------------------------
// Network constants
// ---------------------------------------------------------------------------

export const STELLAR_CAIP2 = {
  testnet: 'stellar:testnet',
  pubnet: 'stellar:pubnet',
} as const;

/** USDC issuer addresses per Stellar network */
export const STELLAR_USDC_ISSUERS: Record<string, string> = {
  'stellar:testnet': 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  'stellar:pubnet': 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  pubnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};

/** Resolve USDC asset string (CODE:ISSUER) for a Stellar network */
export function getStellarUSDCAsset(network: string): string {
  const issuer = STELLAR_USDC_ISSUERS[network];
  return issuer ? `USDC:${issuer}` : '';
}

/** Resolve a raw network string to CAIP-2 format */
export function toStellarCAIP2(network: string): string {
  if (network.startsWith('stellar:')) return network;
  if (network === 'testnet') return STELLAR_CAIP2.testnet;
  if (network === 'pubnet' || network === 'mainnet') return STELLAR_CAIP2.pubnet;
  return network;
}

/** Whether a network identifier refers to a Stellar network */
export function isStellarNetwork(network: string): boolean {
  return (
    network.startsWith('stellar:') ||
    network === 'testnet' ||
    network === 'pubnet'
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StellarFacilitatorConfig {
  /** URL of the veridex stellar-facilitator service */
  facilitatorUrl: string;
  /** Stellar network. Default: 'testnet' */
  network?: 'testnet' | 'pubnet';
  /** Timeout for facilitator requests in ms. Default: 20000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// StellarFacilitatorAdapter
// ---------------------------------------------------------------------------

/**
 * HTTP adapter for the Veridex Stellar x402 facilitator.
 *
 * Use this on the server side (inside `veridexPaywall` config or manually)
 * to verify and settle x402 payments on Stellar.
 *
 * @example
 * ```typescript
 * const adapter = new StellarFacilitatorAdapter({
 *   facilitatorUrl: 'https://facilitator.yourapp.com',
 *   network: 'testnet',
 * });
 *
 * // In a custom paywall:
 * const isValid = await adapter.verify(paymentRequest, paymentResponse);
 * if (isValid) await adapter.settle(paymentRequest, paymentResponse);
 * ```
 */
export class StellarFacilitatorAdapter {
  private facilitatorUrl: string;
  private network: 'testnet' | 'pubnet';
  private timeoutMs: number;

  constructor(config: StellarFacilitatorConfig) {
    this.facilitatorUrl = config.facilitatorUrl.replace(/\/$/, '');
    this.network = config.network || 'testnet';
    this.timeoutMs = config.timeoutMs || 20000;
  }

  /**
   * Whether this adapter can handle a given payment request.
   * Returns true for any `stellar:` CAIP-2 network or stellar scheme.
   */
  canHandle(request: Payment402Request): boolean {
    const network = request.network || '';
    const scheme = (request.scheme as string) || '';
    return (
      isStellarNetwork(network) ||
      scheme === 'exact_stellar' ||
      scheme === 'upto_stellar'
    );
  }

  /** CAIP-2 identifier for the configured network */
  getNetworkCAIP2(): string {
    return STELLAR_CAIP2[this.network];
  }

  /**
   * Verify a Stellar x402 payment proof via the facilitator.
   *
   * @param request - Parsed payment request (from PAYMENT-REQUIRED header)
   * @param response - Payment response (from agent's PAYMENT-SIGNATURE header)
   * @returns true if the payment proof is valid
   */
  async verify(
    request: Payment402Request,
    response: Payment402Response,
  ): Promise<boolean> {
    const requirements = this.buildRequirements(request);
    const body = {
      x402Version: 2,
      paymentPayload: response.paymentPayload,
      paymentRequirements: [requirements],
    };

    try {
      const result = await this.post('/verify', body);
      return result?.isValid === true;
    } catch (err: any) {
      console.warn(`[StellarFacilitator] Verify failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Settle a verified Stellar x402 payment via the facilitator.
   *
   * @param request - Parsed payment request
   * @param response - Signed payment response
   * @returns Settlement result
   */
  async settle(
    request: Payment402Request,
    response: Payment402Response,
  ): Promise<PaymentSettlementResponse> {
    const requirements = this.buildRequirements(request);
    const body = {
      x402Version: 2,
      paymentPayload: response.paymentPayload,
      paymentRequirements: [requirements],
    };

    let result: Record<string, any>;
    try {
      result = await this.post('/settle', body);
    } catch (err: any) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        `Stellar settlement failed: ${err.message}`,
        'Check XLM/USDC balance and facilitator connectivity.',
        true,
      );
    }

    if (!result?.success) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        `Stellar settlement rejected: ${result?.error || result?.invalidReason || 'unknown reason'}`,
        'Ensure the payment payload is valid and the payer has sufficient balance.',
        false,
      );
    }

    return {
      success: true,
      transactionHash: result.txHash || result.transactionHash || '',
      network: request.network,
      amount: request.amount,
    };
  }

  /**
   * Get the supported capabilities of this adapter.
   */
  getCapabilities(): { assets: string[]; network: string; schemes: string[] } {
    return {
      assets: ['XLM', getStellarUSDCAsset(this.getNetworkCAIP2())],
      network: this.getNetworkCAIP2(),
      schemes: ['exact', 'exact_stellar', 'upto', 'upto_stellar'],
    };
  }

  // --------------------------------------------------------------------------

  private buildRequirements(request: Payment402Request) {
    const network = toStellarCAIP2(request.network);
    const asset = request.token || getStellarUSDCAsset(network);
    return {
      x402Version: 2,
      scheme: request.scheme || 'exact',
      network,
      maxAmountRequired: request.amount,
      asset,
      payTo: request.recipient,
    };
  }

  private async post(path: string, body: Record<string, any>): Promise<any> {
    const url = `${this.facilitatorUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }

    return response.json();
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

/**
 * Verify a Stellar x402 payment without instantiating the full adapter.
 */
export async function verifyStellarPayment(
  paymentPayload: string,
  requirements: {
    scheme?: string;
    network: string;
    maxAmountRequired: string;
    asset: string;
    payTo: string;
  },
  facilitatorUrl: string,
  timeoutMs = 20000,
): Promise<{ isValid: boolean; error?: string }> {
  const adapter = new StellarFacilitatorAdapter({ facilitatorUrl, timeoutMs });
  const req: Payment402Request = {
    amount: requirements.maxAmountRequired,
    token: requirements.asset,
    recipient: requirements.payTo,
    chain: 0,
    network: requirements.network,
    scheme: (requirements.scheme as any) || 'exact',
    original: requirements as any,
  };
  try {
    const isValid = await adapter.verify(req, {
      signature: '',
      nonce: '',
      deadline: 0,
      paymentPayload,
    });
    return { isValid };
  } catch (err: any) {
    return { isValid: false, error: err.message };
  }
}

/**
 * Settle a Stellar x402 payment without instantiating the full adapter.
 */
export async function settleStellarPayment(
  paymentPayload: string,
  requirements: {
    scheme?: string;
    network: string;
    maxAmountRequired: string;
    asset: string;
    payTo: string;
  },
  facilitatorUrl: string,
  timeoutMs = 20000,
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const adapter = new StellarFacilitatorAdapter({ facilitatorUrl, timeoutMs });
  const req: Payment402Request = {
    amount: requirements.maxAmountRequired,
    token: requirements.asset,
    recipient: requirements.payTo,
    chain: 0,
    network: requirements.network,
    scheme: (requirements.scheme as any) || 'exact',
    original: requirements as any,
  };
  try {
    const result = await adapter.settle(req, {
      signature: '',
      nonce: '',
      deadline: 0,
      paymentPayload,
    });
    return { success: result.success, txHash: result.transactionHash };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Build Stellar x402 payment requirements for a paywall.
 */
export function buildStellarPaymentRequirements(params: {
  price: number;
  recipientAddress: string;
  network?: 'testnet' | 'pubnet';
  scheme?: 'exact' | 'upto';
  description?: string;
  facilitatorUrl?: string;
}) {
  const network = STELLAR_CAIP2[params.network || 'testnet'];
  const asset = getStellarUSDCAsset(network);
  const stroops = Math.round(params.price * 10_000_000); // USDC on Stellar: 7 decimals

  return {
    scheme: params.scheme || 'exact',
    network,
    maxAmountRequired: String(stroops),
    asset,
    payTo: params.recipientAddress,
    facilitator: params.facilitatorUrl,
    description: params.description || 'Stellar x402 payment',
  };
}
