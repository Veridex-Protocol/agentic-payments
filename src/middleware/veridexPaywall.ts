/**
 * @packageDocumentation
 * @module VeridexPaywall
 * @description
 * Universal server middleware for accepting agentic payments via any supported protocol.
 *
 * Supports all four protocols from the Universal Protocol Abstraction Layer (ADR-0025):
 * - **x402** — HTTP 402 + PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers
 * - **UCP**  — Universal Commerce Protocol manifests + checkout
 * - **ACP**  — OpenAI/Stripe Agentic Commerce Protocol cart + tokens
 * - **AP2**  — Google Agent-to-Pay delegation mandates
 *
 * The middleware auto-detects which protocol an agent used and verifies accordingly.
 * When no payment is attached, it advertises all enabled protocols so any agent can pay.
 *
 * @example Express — simplest usage (all protocols enabled)
 * ```typescript
 * import express from 'express';
 * import { veridexPaywall } from '@veridex/agentic-payments';
 *
 * const app = express();
 *
 * app.get('/premium', veridexPaywall({
 *   amount: '0.01',
 *   recipient: '0xYourAddress',
 * }), (req, res) => {
 *   res.json({ data: 'premium content' });
 * });
 * ```
 *
 * @example Express — specific protocols only
 * ```typescript
 * app.get('/api', veridexPaywall({
 *   amount: '0.50',
 *   recipient: '0xYourAddress',
 *   protocols: ['x402', 'ucp'],
 * }), handler);
 * ```
 *
 * @example Next.js API Route
 * ```typescript
 * import { createPaywallHandler } from '@veridex/agentic-payments';
 *
 * const paywall = createPaywallHandler({
 *   amount: '0.01',
 *   recipient: '0xYourAddress',
 * });
 *
 * export default async function handler(req, res) {
 *   const paid = await paywall(req, res);
 *   if (!paid) return;
 *   res.json({ data: 'premium content' });
 * }
 * ```
 */

import type { ProtocolName } from '../protocols/base/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported server-side protocol names */
export type ServerProtocol = Extract<ProtocolName, 'x402' | 'ucp' | 'acp' | 'ap2'>;

/**
 * Universal paywall configuration.
 *
 * Designed for simplicity — only `amount` and `recipient` are required.
 * Everything else has sensible defaults.
 */
export interface PaywallConfig {
  /**
   * Payment amount.
   * - Human-readable string: `'0.01'` (interpreted as USD/stablecoin)
   * - Raw token units string: `'10000'` (when `rawAmount: true`)
   */
  amount: string;

  /** Recipient address for payments */
  recipient: string;

  /**
   * Which protocols to enable. Default: all four.
   * Agents will see all enabled protocols and pick the one they support.
   */
  protocols?: ServerProtocol[];

  /** Token contract address (default: USDC on the configured network) */
  token?: string;

  /** Network identifier (default: 'base-mainnet') */
  network?: string;

  /** If true, `amount` is in the token's smallest unit. If false (default), it's human-readable. */
  rawAmount?: boolean;

  /** Payment scheme: 'exact' or 'upto' (default: 'exact') */
  scheme?: 'exact' | 'upto';

  /** Facilitator / relayer URL for verification (default: Veridex Relayer) */
  facilitatorUrl?: string;

  /** Custom verification function — overrides built-in verification for all protocols */
  verifyPayment?: (paymentData: string, protocol: ServerProtocol, config: PaywallConfig) => Promise<boolean>;

  /** Human-readable description shown to agents */
  description?: string;

  /** Additional metadata to include in payment requirements */
  extra?: Record<string, unknown>;

  /**
   * UCP-specific: merchant name for the UCP manifest.
   * Defaults to the hostname of the request.
   */
  merchantName?: string;

  /**
   * ACP-specific: list of items in the cart.
   * If omitted, a single item is generated from `amount` and `description`.
   */
  cartItems?: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    currency?: string;
  }>;

  /**
   * AP2-specific: allowed spending categories for mandate negotiation.
   * Default: ['*'] (any category).
   */
  allowedCategories?: string[];

  /**
   * AP2-specific: how long the mandate is valid (seconds).
   * Default: 300 (5 minutes).
   */
  mandateTTLSeconds?: number;
}

/** Payment info attached to `req.veridexPayment` after successful verification */
export interface VeridexPaymentInfo {
  /** Whether the payment was verified */
  verified: boolean;
  /** Which protocol the agent used */
  protocol: ServerProtocol;
  /** Amount paid (human-readable) */
  amount: string;
  /** Token used */
  token: string;
  /** Network */
  network: string;
  /** Raw payment data from the agent */
  rawPaymentData?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FACILITATOR_URL = 'https://relayer.veridex.network/api/v1';
const DEFAULT_NETWORK = 'base-mainnet';
const DEFAULT_USDC_ADDRESSES: Record<string, string> = {
  'base-mainnet': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'ethereum-mainnet': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'ethereum-sepolia': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  'optimism-mainnet': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  'arbitrum-mainnet': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
};
const ALL_PROTOCOLS: ServerProtocol[] = ['x402', 'ucp', 'acp', 'ap2'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PaymentPayloadDecoded {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: number;
      validBefore: number;
      nonce: string;
    };
  };
}

/** Resolve config defaults */
function resolveConfig(config: PaywallConfig): Required<Pick<PaywallConfig, 'network' | 'token' | 'scheme' | 'facilitatorUrl' | 'protocols'>> & PaywallConfig {
  const network = config.network || DEFAULT_NETWORK;
  const token = config.token || DEFAULT_USDC_ADDRESSES[network] || DEFAULT_USDC_ADDRESSES['base-mainnet'];
  const scheme = config.scheme || 'exact';
  const facilitatorUrl = config.facilitatorUrl || DEFAULT_FACILITATOR_URL;
  const protocols = config.protocols || ALL_PROTOCOLS;
  return { ...config, network, token, scheme, facilitatorUrl, protocols };
}

/** Convert human-readable amount to raw token units (6 decimals for USDC) */
function toRawAmount(amount: string, rawAmount?: boolean): string {
  if (rawAmount) return amount;
  const parsed = parseFloat(amount);
  if (isNaN(parsed)) return amount;
  return String(Math.round(parsed * 1_000_000));
}

/** Convert raw token units back to human-readable */
function toHumanAmount(rawAmount: string): string {
  const parsed = parseInt(rawAmount, 10);
  if (isNaN(parsed)) return rawAmount;
  return (parsed / 1_000_000).toFixed(6).replace(/\.?0+$/, '');
}

// ---------------------------------------------------------------------------
// Protocol detection on incoming requests
// ---------------------------------------------------------------------------

/** Detect which protocol an agent used based on request headers/body */
function detectIncomingProtocol(req: any): { protocol: ServerProtocol; data: string } | null {
  const headers = req.headers || {};

  // x402: PAYMENT-SIGNATURE header
  const x402Sig = headers['payment-signature'] || headers['PAYMENT-SIGNATURE'];
  if (x402Sig) {
    return { protocol: 'x402', data: x402Sig };
  }

  // UCP: x-ucp-payment-credential header
  const ucpCred = headers['x-ucp-payment-credential'];
  if (ucpCred) {
    return { protocol: 'ucp', data: ucpCred };
  }

  // ACP: x-acp-payment-token header
  const acpToken = headers['x-acp-payment-token'];
  if (acpToken) {
    return { protocol: 'acp', data: acpToken };
  }

  // AP2: x-ap2-fulfillment header
  const ap2Fulfillment = headers['x-ap2-fulfillment'];
  if (ap2Fulfillment) {
    return { protocol: 'ap2', data: ap2Fulfillment };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Protocol-specific response headers (advertising)
// ---------------------------------------------------------------------------

/** Set response headers to advertise all enabled protocols */
function advertiseProtocols(
  res: any,
  req: any,
  resolved: ReturnType<typeof resolveConfig>,
  error?: string
): void {
  const rawAmt = toRawAmount(resolved.amount, resolved.rawAmount);
  const humanAmt = resolved.rawAmount ? toHumanAmount(resolved.amount) : resolved.amount;
  const enabledSet = new Set(resolved.protocols);

  // Always set Content-Type
  res.setHeader('Content-Type', 'application/json');

  // x402: PAYMENT-REQUIRED header (base64 JSON)
  if (enabledSet.has('x402')) {
    const paymentRequired = {
      paymentRequirements: [{
        scheme: resolved.scheme,
        network: resolved.network,
        maxAmountRequired: rawAmt,
        asset: resolved.token,
        payTo: resolved.recipient,
        facilitator: resolved.facilitatorUrl,
        description: resolved.description,
        extra: resolved.extra,
      }],
    };
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');
    res.setHeader('PAYMENT-REQUIRED', encoded);
  }

  // UCP: x-ucp-initiation-url header
  if (enabledSet.has('ucp')) {
    const origin = getRequestOrigin(req);
    const ucpUrl = `${origin}/.well-known/ucp`;
    res.setHeader('x-ucp-initiation-url', ucpUrl);
    // Also set Link header for manifest discovery
    res.setHeader('Link', `<${ucpUrl}>; rel="ucp-manifest"`);
  }

  // ACP: openai-acp-version + x-acp-checkout-url headers
  if (enabledSet.has('acp')) {
    const origin = getRequestOrigin(req);
    res.setHeader('openai-acp-version', '2026-01');
    res.setHeader('x-acp-checkout-url', `${origin}/.well-known/acp-checkout`);
  }

  // AP2: x-ap2-mandate-url header
  if (enabledSet.has('ap2')) {
    const origin = getRequestOrigin(req);
    res.setHeader('x-ap2-mandate-url', `${origin}/.well-known/ap2-mandate`);
  }

  // Build response body
  const body: Record<string, any> = {
    protocols: resolved.protocols,
    amount: humanAmt,
    amountRaw: rawAmt,
    token: resolved.token,
    network: resolved.network,
    recipient: resolved.recipient,
    description: resolved.description,
  };

  if (error) {
    body.error = error;
  }

  res.status(402);
  res.json(body);
}

/** Extract origin from request (handles proxied requests) */
function getRequestOrigin(req: any): string {
  const proto = req.headers?.['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost';
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Protocol-specific verification
// ---------------------------------------------------------------------------

async function verifyX402(data: string, resolved: ReturnType<typeof resolveConfig>): Promise<boolean> {
  const rawAmt = toRawAmount(resolved.amount, resolved.rawAmount);

  try {
    const decoded = JSON.parse(
      Buffer.from(data, 'base64').toString('utf-8')
    ) as PaymentPayloadDecoded;

    if (!decoded.payload?.signature || !decoded.payload?.authorization) {
      return false;
    }

    if (decoded.payload.authorization.to.toLowerCase() !== resolved.recipient.toLowerCase()) {
      return false;
    }

    if (BigInt(decoded.payload.authorization.value) < BigInt(rawAmt)) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    if (decoded.payload.authorization.validBefore < now) {
      return false;
    }

    // Verify via facilitator
    try {
      const verifyResponse = await fetch(`${resolved.facilitatorUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentPayload: data,
          paymentRequirements: {
            scheme: resolved.scheme,
            network: resolved.network,
            maxAmountRequired: rawAmt,
            asset: resolved.token,
            payTo: resolved.recipient,
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (verifyResponse.ok) {
        const result = await verifyResponse.json();
        return result.isValid === true;
      }
    } catch {
      console.warn('[veridexPaywall] Facilitator unavailable, using local validation');
    }

    return true;
  } catch {
    return false;
  }
}

async function verifyUCP(data: string, resolved: ReturnType<typeof resolveConfig>): Promise<boolean> {
  try {
    const credential = JSON.parse(data);

    // Verify the credential has required fields
    if (!credential.payload || !credential.signature || !credential.signer) {
      return false;
    }

    // Verify recipient matches
    const payload = typeof credential.payload === 'string'
      ? JSON.parse(credential.payload)
      : credential.payload;

    if (payload.recipient?.toLowerCase() !== resolved.recipient.toLowerCase()) {
      return false;
    }

    // Verify via facilitator
    try {
      const verifyResponse = await fetch(`${resolved.facilitatorUrl}/verify-ucp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: data, recipient: resolved.recipient }),
        signal: AbortSignal.timeout(10000),
      });

      if (verifyResponse.ok) {
        const result = await verifyResponse.json();
        return result.isValid === true;
      }
    } catch {
      console.warn('[veridexPaywall] UCP facilitator unavailable, using local validation');
    }

    // Local: credential structure is valid
    return true;
  } catch {
    return false;
  }
}

async function verifyACP(data: string, resolved: ReturnType<typeof resolveConfig>): Promise<boolean> {
  try {
    const decoded = JSON.parse(
      Buffer.from(data, 'base64url').toString('utf-8')
    );

    if (!decoded.signature || !decoded.cart_id) {
      return false;
    }

    // Verify merchant_id or amount
    const rawAmt = toRawAmount(resolved.amount, resolved.rawAmount);
    if (decoded.amount_cents !== undefined) {
      const requiredCents = Math.round(parseFloat(resolved.rawAmount ? toHumanAmount(rawAmt) : resolved.amount) * 100);
      if (decoded.amount_cents < requiredCents) {
        return false;
      }
    }

    // Verify via facilitator
    try {
      const verifyResponse = await fetch(`${resolved.facilitatorUrl}/verify-acp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: data, recipient: resolved.recipient }),
        signal: AbortSignal.timeout(10000),
      });

      if (verifyResponse.ok) {
        const result = await verifyResponse.json();
        return result.isValid === true;
      }
    } catch {
      console.warn('[veridexPaywall] ACP facilitator unavailable, using local validation');
    }

    return true;
  } catch {
    return false;
  }
}

async function verifyAP2(data: string, resolved: ReturnType<typeof resolveConfig>): Promise<boolean> {
  try {
    const fulfillment = JSON.parse(data);

    if (!fulfillment.mandate_id || !fulfillment.signature) {
      return false;
    }

    // Verify the fulfillment amount covers our requirement
    const maxValue = fulfillment.cart_mandate_response?.max_value;
    if (maxValue) {
      const humanAmt = parseFloat(resolved.rawAmount ? toHumanAmount(toRawAmount(resolved.amount, resolved.rawAmount)) : resolved.amount);
      if (maxValue.amount < humanAmt) {
        return false;
      }
    }

    // Verify via facilitator
    try {
      const verifyResponse = await fetch(`${resolved.facilitatorUrl}/verify-ap2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fulfillment: data, recipient: resolved.recipient }),
        signal: AbortSignal.timeout(10000),
      });

      if (verifyResponse.ok) {
        const result = await verifyResponse.json();
        return result.isValid === true;
      }
    } catch {
      console.warn('[veridexPaywall] AP2 facilitator unavailable, using local validation');
    }

    return true;
  } catch {
    return false;
  }
}

/** Route verification to the correct protocol handler */
async function verifyPayment(
  protocol: ServerProtocol,
  data: string,
  resolved: ReturnType<typeof resolveConfig>
): Promise<boolean> {
  // Custom verifier takes precedence
  if (resolved.verifyPayment) {
    return resolved.verifyPayment(data, protocol, resolved);
  }

  switch (protocol) {
    case 'x402': return verifyX402(data, resolved);
    case 'ucp':  return verifyUCP(data, resolved);
    case 'acp':  return verifyACP(data, resolved);
    case 'ap2':  return verifyAP2(data, resolved);
    default:     return false;
  }
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

async function settlePayment(
  protocol: ServerProtocol,
  data: string,
  resolved: ReturnType<typeof resolveConfig>
): Promise<void> {
  const rawAmt = toRawAmount(resolved.amount, resolved.rawAmount);

  const response = await fetch(`${resolved.facilitatorUrl}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol,
      paymentPayload: data,
      paymentRequirements: {
        scheme: resolved.scheme,
        network: resolved.network,
        maxAmountRequired: rawAmt,
        asset: resolved.token,
        payTo: resolved.recipient,
      },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Settlement failed: ${response.status} ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Express middleware that accepts payments via any enabled protocol.
 *
 * When no payment is attached, returns 402 with headers advertising all
 * enabled protocols. When a payment is detected, verifies it and calls `next()`.
 *
 * @example Simplest usage — all protocols, USDC on Base
 * ```typescript
 * app.get('/premium', veridexPaywall({
 *   amount: '0.01',
 *   recipient: '0xYourAddress',
 * }), handler);
 * ```
 *
 * @example Specific protocols only
 * ```typescript
 * app.get('/api', veridexPaywall({
 *   amount: '0.50',
 *   recipient: '0xYourAddress',
 *   protocols: ['x402', 'ucp'],
 *   network: 'base-sepolia',
 * }), handler);
 * ```
 */
export function veridexPaywall(config: PaywallConfig) {
  const resolved = resolveConfig(config);

  return async (req: any, res: any, next: any) => {
    // Detect incoming payment
    const incoming = detectIncomingProtocol(req);

    if (!incoming) {
      return advertiseProtocols(res, req, resolved);
    }

    // Check that the agent used an enabled protocol
    if (!resolved.protocols.includes(incoming.protocol)) {
      return advertiseProtocols(res, req, resolved,
        `Protocol '${incoming.protocol}' is not enabled. Supported: ${resolved.protocols.join(', ')}`
      );
    }

    // Verify the payment
    try {
      const isValid = await verifyPayment(incoming.protocol, incoming.data, resolved);

      if (!isValid) {
        return advertiseProtocols(res, req, resolved, 'Payment verification failed');
      }

      // Settle asynchronously
      settlePayment(incoming.protocol, incoming.data, resolved).catch(err => {
        console.error(`[veridexPaywall] ${incoming.protocol} settlement error (non-blocking):`, err.message);
      });

      // Attach payment info to request
      const humanAmt = resolved.rawAmount ? toHumanAmount(resolved.amount) : resolved.amount;
      req.veridexPayment = {
        verified: true,
        protocol: incoming.protocol,
        amount: humanAmt,
        token: resolved.token,
        network: resolved.network,
        rawPaymentData: incoming.data,
      } satisfies VeridexPaymentInfo;

      next();
    } catch (err: any) {
      return advertiseProtocols(res, req, resolved, err.message);
    }
  };
}

/**
 * Standalone paywall handler for Next.js API routes, Hono, or any framework.
 * Returns `true` if payment is valid, `false` if 402 was sent.
 *
 * @example Next.js
 * ```typescript
 * const paywall = createPaywallHandler({ amount: '0.01', recipient: '0x...' });
 *
 * export default async function handler(req, res) {
 *   const paid = await paywall(req, res);
 *   if (!paid) return;
 *   res.json({ data: 'premium content' });
 * }
 * ```
 */
export function createPaywallHandler(config: PaywallConfig) {
  const resolved = resolveConfig(config);

  return async (req: any, res: any): Promise<boolean> => {
    const incoming = detectIncomingProtocol(req);

    if (!incoming) {
      advertiseProtocols(res, req, resolved);
      return false;
    }

    if (!resolved.protocols.includes(incoming.protocol)) {
      advertiseProtocols(res, req, resolved,
        `Protocol '${incoming.protocol}' is not enabled. Supported: ${resolved.protocols.join(', ')}`
      );
      return false;
    }

    try {
      const isValid = await verifyPayment(incoming.protocol, incoming.data, resolved);
      if (!isValid) {
        advertiseProtocols(res, req, resolved, 'Payment verification failed');
        return false;
      }

      settlePayment(incoming.protocol, incoming.data, resolved).catch(err => {
        console.error(`[veridexPaywall] ${incoming.protocol} settlement error:`, err.message);
      });

      return true;
    } catch (err: any) {
      advertiseProtocols(res, req, resolved, err.message);
      return false;
    }
  };
}

/**
 * Express router that serves protocol discovery endpoints.
 *
 * Mount this at your app root to serve `.well-known` endpoints for UCP, ACP, and AP2.
 * This is optional — the middleware headers are sufficient for most agents.
 *
 * @example
 * ```typescript
 * import { veridexPaywall, createProtocolRoutes } from '@veridex/agentic-payments';
 *
 * // Serve discovery endpoints
 * app.use(createProtocolRoutes({
 *   amount: '0.01',
 *   recipient: '0xYourAddress',
 *   merchantName: 'My API',
 * }));
 *
 * // Protect routes
 * app.get('/premium', veridexPaywall({ amount: '0.01', recipient: '0x...' }), handler);
 * ```
 */
export function createProtocolRoutes(config: PaywallConfig) {
  const resolved = resolveConfig(config);
  const rawAmt = toRawAmount(resolved.amount, resolved.rawAmount);
  const humanAmt = resolved.rawAmount ? toHumanAmount(resolved.amount) : resolved.amount;

  return (req: any, res: any, next: any) => {
    const path = req.path || req.url;

    // UCP manifest
    if (path === '/.well-known/ucp' && resolved.protocols.includes('ucp')) {
      return res.json({
        id: resolved.merchantName || req.headers?.host || 'veridex-merchant',
        name: resolved.merchantName || 'Veridex Merchant',
        capabilities: ['checkout'],
        paymentHandlers: [{
          id: 'veridex-handler',
          name: 'dev.veridex.passkey_payment',
          version: '2.0',
          config: {
            recipient_address: resolved.recipient,
            chain_id: networkToChainId(resolved.network),
            token_address: resolved.token,
            amount: rawAmt,
          },
        }],
      });
    }

    // ACP checkout
    if (path === '/.well-known/acp-checkout' && resolved.protocols.includes('acp')) {
      const items = resolved.cartItems || [{
        name: resolved.description || 'API Access',
        quantity: 1,
        unitPrice: parseFloat(humanAmt),
        currency: 'USD',
      }];

      return res.json({
        id: `cart-${Date.now()}`,
        items: items.map((item, i) => ({
          id: `item-${i}`,
          name: item.name,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          currency: item.currency || 'USD',
        })),
        total: items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
        currency: 'USD',
        merchant: {
          id: resolved.merchantName || 'veridex-merchant',
          name: resolved.merchantName || 'Veridex Merchant',
        },
        checkout_url: `${getRequestOrigin(req)}/.well-known/acp-checkout`,
      });
    }

    // AP2 mandate
    if (path === '/.well-known/ap2-mandate' && resolved.protocols.includes('ap2')) {
      const ttl = resolved.mandateTTLSeconds || 300;
      return res.json({
        version: '2026-01',
        mandate_id: `mandate-${Date.now()}`,
        cart_mandate: {
          max_value: {
            amount: parseFloat(humanAmt),
            currency: 'USD',
          },
          allowed_categories: resolved.allowedCategories || ['*'],
          expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        },
        payment_mandate: {
          provider: 'veridex',
          credential_type: 'session_key',
        },
        intent_mandate: {
          source: 'merchant_request',
          verified_at: new Date().toISOString(),
          description: resolved.description,
        },
        fulfillment_url: `${getRequestOrigin(req)}/.well-known/ap2-mandate`,
      });
    }

    next();
  };
}

/** Map network string to chain ID */
function networkToChainId(network: string): number {
  const map: Record<string, number> = {
    'base-mainnet': 8453,
    'base-sepolia': 84532,
    'ethereum-mainnet': 1,
    'ethereum-sepolia': 11155111,
    'optimism-mainnet': 10,
    'arbitrum-mainnet': 42161,
  };
  return map[network] || 8453;
}
