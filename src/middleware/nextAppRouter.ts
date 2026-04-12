/**
 * @packageDocumentation
 * @module nextAppRouter
 * @description
 * Next.js App Router adapter for the Veridex paywall middleware.
 *
 * The core `veridexPaywall` middleware uses Express-style `req/res/next` signatures.
 * This module provides equivalent functionality for Next.js App Router route handlers
 * that use `NextRequest` / `NextResponse` (or plain `Request` / `Response`).
 *
 * @example
 * ```typescript
 * // app/api/paywall/[shortId]/route.ts
 * import { withPaywall, buildPaywallResponse } from '@veridex/agentic-payments/middleware/nextAppRouter';
 *
 * export async function GET(req: Request) {
 *   const result = await withPaywall(req, {
 *     amount: '0.50',
 *     recipient: '0xCreatorAddress',
 *     network: 'base-sepolia',
 *   });
 *
 *   if (!result.paid) {
 *     return result.response; // 402 with payment headers
 *   }
 *
 *   // Payment verified — return content
 *   return Response.json({ url: 'https://secret-content.com' });
 * }
 * ```
 */

import type { ServerProtocol, VeridexPaymentInfo } from './veridexPaywall';
import {
  toCAIP2,
  getUSDCAddress,
  toUSDCRaw,
  getFacilitatorUrl,
  verifyX402Payment,
  settleX402Payment,
} from '../x402/adapters/EVMFacilitatorAdapter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the Next.js App Router paywall */
export interface AppRouterPaywallConfig {
  /** Payment amount in human-readable format (e.g., '0.50') */
  amount: string;
  /** Recipient address */
  recipient: string;
  /** Network identifier (friendly name or CAIP-2). Default: 'base-sepolia' */
  network?: string;
  /** Which protocols to enable. Default: ['x402', 'ucp', 'acp', 'ap2'] */
  protocols?: ServerProtocol[];
  /** Token contract address. Default: USDC on the configured network */
  token?: string;
  /** Payment scheme. Default: 'exact' */
  scheme?: 'exact' | 'upto';
  /** Custom facilitator URL */
  facilitatorUrl?: string;
  /** Fallback facilitator URL */
  fallbackFacilitatorUrl?: string;
  /** Timeout for facilitator verification and settlement in ms */
  timeoutMs?: number;
  /** Human-readable description */
  description?: string;
  /** Additional metadata */
  extra?: Record<string, unknown>;
  /** CORS headers to include in responses */
  corsHeaders?: Record<string, string>;
}

/** Result of the paywall check */
export interface PaywallResult {
  /** Whether payment was verified */
  paid: boolean;
  /** If not paid, the 402 Response to return */
  response: Response;
  /** If paid, info about the payment */
  payment?: VeridexPaymentInfo;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_NETWORK = 'base-sepolia';
const ALL_PROTOCOLS: ServerProtocol[] = ['x402', 'ucp', 'acp', 'ap2'];

// ---------------------------------------------------------------------------
// Protocol detection
// ---------------------------------------------------------------------------

function detectProtocol(headers: Headers): { protocol: ServerProtocol; data: string } | null {
  const x402 = headers.get('payment-signature') || headers.get('PAYMENT-SIGNATURE');
  if (x402) return { protocol: 'x402', data: x402 };

  const ucp = headers.get('x-ucp-payment-credential');
  if (ucp) return { protocol: 'ucp', data: ucp };

  const acp = headers.get('x-acp-payment-token');
  if (acp) return { protocol: 'acp', data: acp };

  const ap2 = headers.get('x-ap2-fulfillment');
  if (ap2) return { protocol: 'ap2', data: ap2 };

  return null;
}

// ---------------------------------------------------------------------------
// Local x402 verification (structural check before facilitator)
// ---------------------------------------------------------------------------

function localVerifyX402(data: string, recipient: string, rawAmount: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'));
    if (!decoded.payload?.signature || !decoded.payload?.authorization) return false;
    if (decoded.payload.authorization.to.toLowerCase() !== recipient.toLowerCase()) return false;
    if (BigInt(decoded.payload.authorization.value) < BigInt(rawAmount)) return false;
    const now = Math.floor(Date.now() / 1000);
    if (decoded.payload.authorization.validBefore < now) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Build 402 Response
// ---------------------------------------------------------------------------

/**
 * Build a 402 Payment Required response with all protocol headers.
 */
export function buildPaywallResponse(
  config: AppRouterPaywallConfig,
  error?: string
): Response {
  const network = config.network || DEFAULT_NETWORK;
  const caip2 = toCAIP2(network);
  const token = config.token || getUSDCAddress(caip2) || getUSDCAddress(network);
  const rawAmount = toUSDCRaw(parseFloat(config.amount));
  const protocols = config.protocols || ALL_PROTOCOLS;
  const scheme = config.scheme || 'exact';
  const facilitatorUrl = config.facilitatorUrl || getFacilitatorUrl(network);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.corsHeaders || {}),
  };

  // x402: PAYMENT-REQUIRED header
  if (protocols.includes('x402')) {
    const paymentRequired = {
      x402Version: 2,
      paymentRequirements: [{
        scheme,
        network: caip2,
        maxAmountRequired: rawAmount,
        asset: token,
        payTo: config.recipient,
        facilitator: facilitatorUrl,
        description: config.description,
        extra: config.extra,
      }],
    };
    headers['PAYMENT-REQUIRED'] = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');
  }

  const body = {
    error: error || 'Payment Required',
    protocols,
    amount: config.amount,
    amountRaw: rawAmount,
    token,
    network: caip2,
    recipient: config.recipient,
    description: config.description,
  };

  return new Response(JSON.stringify(body), {
    status: 402,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Main paywall function
// ---------------------------------------------------------------------------

/**
 * Check if a request has a valid payment attached.
 *
 * For Next.js App Router route handlers. Returns a `PaywallResult` indicating
 * whether the payment was verified. If not, includes a pre-built 402 Response.
 *
 * @param request - The incoming Request (NextRequest or standard Request)
 * @param config - Paywall configuration
 * @returns PaywallResult with `paid` boolean and optional `response`/`payment`
 */
export async function withPaywall(
  request: Request,
  config: AppRouterPaywallConfig
): Promise<PaywallResult> {
  const network = config.network || DEFAULT_NETWORK;
  const caip2 = toCAIP2(network);
  const token = config.token || getUSDCAddress(caip2) || getUSDCAddress(network);
  const rawAmount = toUSDCRaw(parseFloat(config.amount));
  const protocols = config.protocols || ALL_PROTOCOLS;

  // Detect incoming payment
  const incoming = detectProtocol(request.headers);

  if (!incoming) {
    return {
      paid: false,
      response: buildPaywallResponse(config),
    };
  }

  // Check protocol is enabled
  if (!protocols.includes(incoming.protocol)) {
    return {
      paid: false,
      response: buildPaywallResponse(
        config,
        `Protocol '${incoming.protocol}' is not enabled. Supported: ${protocols.join(', ')}`
      ),
    };
  }

  // Verify payment
  try {
    let isValid = false;

    if (incoming.protocol === 'x402') {
      // Local structural check first
      if (!localVerifyX402(incoming.data, config.recipient, rawAmount)) {
        return {
          paid: false,
          response: buildPaywallResponse(config, 'Payment verification failed: invalid proof structure'),
        };
      }

      // Facilitator verification
      const result = await verifyX402Payment(
        incoming.data,
        {
          scheme: config.scheme || 'exact',
          network: caip2,
          maxAmountRequired: rawAmount,
          asset: token,
          payTo: config.recipient,
        },
        {
          facilitatorUrl: config.facilitatorUrl,
          fallbackUrl: config.fallbackFacilitatorUrl,
          timeoutMs: config.timeoutMs,
        }
      );
      isValid = result.isValid;
    } else {
      // For non-x402 protocols, delegate to facilitator
      // TODO: Add UCP/ACP/AP2 verification when needed
      isValid = false;
    }

    if (!isValid) {
      return {
        paid: false,
        response: buildPaywallResponse(config, 'Payment verification failed'),
      };
    }

    // Settle asynchronously (non-blocking)
    settleX402Payment(
      incoming.data,
      {
        scheme: config.scheme || 'exact',
        network: caip2,
        maxAmountRequired: rawAmount,
        asset: token,
        payTo: config.recipient,
      },
      {
        facilitatorUrl: config.facilitatorUrl,
        fallbackUrl: config.fallbackFacilitatorUrl,
        timeoutMs: config.timeoutMs,
      }
    ).catch(err => {
      console.error(`[withPaywall] Settlement error (non-blocking):`, err.message || err);
    });

    const payment: VeridexPaymentInfo = {
      verified: true,
      protocol: incoming.protocol,
      amount: config.amount,
      token,
      network: caip2,
      rawPaymentData: incoming.data,
    };

    return {
      paid: true,
      response: new Response(null, { status: 200 }),
      payment,
    };
  } catch (err: any) {
    return {
      paid: false,
      response: buildPaywallResponse(config, err.message),
    };
  }
}
