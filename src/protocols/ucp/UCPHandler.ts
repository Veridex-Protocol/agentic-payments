/**
 * @packageDocumentation
 * @module UCPHandler
 * @description
 * Protocol handler for Universal Commerce Protocol (UCP).
 *
 * UCP is a discovery + negotiation framework (Google/Shopify) that enables
 * merchants to expose checkout capabilities via `.well-known/ucp` manifests
 * or `Link: rel="ucp-manifest"` headers.
 *
 * Flow:
 * 1. Detect UCP manifest via Link header or .well-known/ucp
 * 2. Discover merchant capabilities and payment handlers
 * 3. Select Veridex payment handler (dev.veridex.passkey_payment)
 * 4. Generate cryptographic credential using session key
 * 5. Complete checkout
 */

import { ProtocolHandler } from '../base/ProtocolHandler';
import type { CostEstimate, ProtocolContext, ProtocolName } from '../base/types';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';
import { CapabilityNegotiator } from '../../ucp/CapabilityNegotiator';
import { ethers } from 'ethers';

interface UCPPaymentHandler {
  id: string;
  name: string;
  version?: string;
  config: Record<string, any>;
}

/**
 * A UCP merchant manifest, served from `.well-known/ucp` or a
 * `Link: rel="ucp-manifest"` endpoint. It advertises the capabilities the
 * merchant supports, the payment handlers it accepts, and the endpoint used to
 * create a checkout session.
 *
 * This is an *untrusted, merchant-supplied* document: it is parsed and
 * validated by {@link UCPHandler.parseManifest} before any field is used.
 */
interface UCPManifest {
  /** UCP manifest schema version (required). */
  version: string;
  /** Human-readable merchant/storefront name. */
  name?: string;
  /** Capabilities the merchant advertises (e.g. `checkout`, `orders`). */
  capabilities: string[];
  /** Payment handlers the merchant accepts. */
  paymentHandlers: UCPPaymentHandler[];
  /**
   * Endpoint used to create a checkout session. May be absolute or relative to
   * the manifest origin; {@link UCPHandler.resolveCheckoutEndpoint} normalizes it.
   */
  checkoutUrl?: string;
}

/** Hard cap on a fetched manifest body to bound memory on a hostile merchant. */
const MAX_MANIFEST_BYTES = 256 * 1024;
/** The capability a merchant must advertise for an agent checkout to proceed. */
const REQUIRED_CAPABILITY = 'checkout';

interface UCPCheckoutResponse {
  checkout_id: string;
  handlers: UCPPaymentHandler[];
  total: {
    amount: string;
    currency: string;
  };
  status: string;
}

const VERIDEX_HANDLER_NAME = 'dev.veridex.passkey_payment';

export class UCPHandler extends ProtocolHandler {
  readonly protocolName: ProtocolName = 'ucp';
  readonly priority = 100;

  private readonly negotiator = new CapabilityNegotiator();

  async canHandle(response: Response, url: string): Promise<boolean> {
    // Check Link header for UCP manifest
    const linkHeader = response.headers.get('link');
    if (linkHeader?.includes('rel="ucp-manifest"')) return true;

    // Check for UCP initiation header (from 402 responses)
    if (response.headers.has('x-ucp-initiation-url')) return true;

    // Check .well-known/ucp (only for non-402 responses to avoid false positives)
    if (response.status !== 402) {
      try {
        const origin = new URL(url).origin;
        const wellKnown = await fetch(`${origin}/.well-known/ucp`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000),
        });
        return wellKnown.ok;
      } catch {
        return false;
      }
    }

    return false;
  }

  async handle(
    url: string,
    options: RequestInit,
    context: ProtocolContext,
    originalResponse?: Response
  ): Promise<Response> {
    const { session } = context;

    // Determine the checkout endpoint.
    //
    // A direct `x-ucp-initiation-url` is a pre-negotiated checkout endpoint and
    // is used as-is. Otherwise we follow the UCP discovery flow: resolve the
    // merchant manifest, validate it, confirm it advertises checkout + the
    // Veridex handler, and derive the checkout endpoint *from the manifest*.
    let checkoutUrl: string;

    const initiationUrl = originalResponse?.headers.get('x-ucp-initiation-url');
    if (initiationUrl) {
      checkoutUrl = initiationUrl;
    } else {
      const manifestUrl = this.resolveManifestUrl(url, originalResponse);
      const manifest = await this.discoverManifest(manifestUrl);
      this.assertManifestSupportsVeridex(manifest, manifestUrl);
      checkoutUrl = this.resolveCheckoutEndpoint(manifest, manifestUrl);
    }

    try {
      // 1. Create checkout session
      const checkout = await this.createCheckout(checkoutUrl);

      // 2. Find Veridex payment handler
      const handler = checkout.handlers.find(h => h.name === VERIDEX_HANDLER_NAME);
      if (!handler) {
        throw new AgentPaymentError(
          AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
          `Merchant does not support Veridex payments. Available handlers: ${checkout.handlers.map(h => h.name).join(', ')}`,
          'The merchant needs to add dev.veridex.passkey_payment as a payment handler.',
          false
        );
      }

      // 3. Check spending limits
      const amountUSD = this.parseUSDAmount(checkout.total.amount, checkout.total.currency);
      const remainingDaily = session.config.dailyLimitUSD - session.metadata.dailySpentUSD;

      if (amountUSD > session.config.perTransactionLimitUSD) {
        throw AgentPaymentError.fromLimitExceeded(
          `UCP checkout $${amountUSD.toFixed(2)} exceeds per-transaction limit`,
          { amountUSD }
        );
      }
      if (amountUSD > remainingDaily) {
        throw AgentPaymentError.fromLimitExceeded(
          `UCP checkout $${amountUSD.toFixed(2)} exceeds remaining daily limit $${remainingDaily.toFixed(2)}`,
          { amountUSD, remainingDaily }
        );
      }

      // 4. Generate credential (pass pre-decrypted wallet)
      const credential = await this.createCredential(session, handler, checkout, context.signerWallet);

      // 5. Complete checkout
      const completeUrl = `${checkoutUrl}/${checkout.checkout_id}/complete`;
      await this.completeCheckout(completeUrl, credential);

      // 6. Retry original request (merchant should now grant access)
      return await fetch(url, options);
    } catch (error: any) {
      if (error instanceof AgentPaymentError) throw error;
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP checkout failed: ${error.message}`,
        'The Universal Commerce Protocol checkout could not be completed.',
        true,
        { checkoutUrl, originalError: error.message }
      );
    }
  }

  async estimateCost(response: Response): Promise<CostEstimate> {
    const ucpUrl = response.headers.get('x-ucp-initiation-url');
    if (!ucpUrl) {
      return {
        amountUSD: 0,
        amountRaw: '0',
        token: 'unknown',
        chain: 0,
        scheme: 'ucp',
        confidence: 0,
        description: 'UCP checkout URL not found',
      };
    }

    try {
      const checkout = await this.createCheckout(ucpUrl);
      const amountUSD = this.parseUSDAmount(checkout.total.amount, checkout.total.currency);

      return {
        amountUSD,
        amountRaw: checkout.total.amount,
        token: checkout.total.currency,
        chain: 0,
        scheme: 'ucp',
        confidence: 0.9,
        description: `UCP checkout for ${checkout.total.amount} ${checkout.total.currency}`,
      };
    } catch {
      return {
        amountUSD: 0,
        amountRaw: '0',
        token: 'unknown',
        chain: 0,
        scheme: 'ucp',
        confidence: 0,
        description: 'Failed to fetch UCP checkout details',
      };
    }
  }

  /**
   * Resolve the URL of the merchant's UCP manifest.
   *
   * Prefers a `Link: rel="ucp-manifest"` target when present, otherwise falls
   * back to the well-known location. The resolved URL is constrained to the
   * same origin as the requested resource: a `Link` header is merchant-
   * controlled, so following it cross-origin would be an SSRF vector (e.g. a
   * manifest pointing at an internal metadata service). Cross-origin targets
   * are rejected.
   */
  private resolveManifestUrl(url: string, originalResponse?: Response): string {
    const origin = new URL(url).origin;
    const fallback = `${origin}/.well-known/ucp`;

    const linkHeader = originalResponse?.headers.get('link');
    const match = linkHeader?.match(/<([^>]+)>;\s*rel="ucp-manifest"/);
    if (!match) return fallback;

    let manifestUrl: URL;
    try {
      manifestUrl = new URL(match[1], origin);
    } catch {
      return fallback;
    }

    if (manifestUrl.origin !== origin) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP manifest link points to a different origin (${manifestUrl.origin}) than the resource (${origin})`,
        'The merchant manifest link is cross-origin and was rejected for safety.',
        false,
        { resourceOrigin: origin, manifestOrigin: manifestUrl.origin }
      );
    }

    return manifestUrl.toString();
  }

  /**
   * Fetch and validate the merchant manifest. The body is size-bounded and
   * parsed defensively — every field is treated as untrusted input.
   */
  private async discoverManifest(manifestUrl: string): Promise<UCPManifest> {
    let response: Response;
    try {
      response = await fetch(manifestUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error: any) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `Failed to fetch UCP manifest from ${manifestUrl}: ${error?.message ?? 'network error'}`,
        'The merchant UCP manifest could not be retrieved.',
        true,
        { manifestUrl }
      );
    }

    if (!response.ok) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP manifest fetch returned ${response.status} ${response.statusText}`,
        'The merchant UCP manifest could not be retrieved.',
        response.status >= 500,
        { manifestUrl, status: response.status }
      );
    }

    const body = await response.text();
    if (body.length > MAX_MANIFEST_BYTES) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP manifest exceeds maximum size (${body.length} > ${MAX_MANIFEST_BYTES} bytes)`,
        'The merchant UCP manifest was too large to process.',
        false,
        { manifestUrl }
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP manifest at ${manifestUrl} is not valid JSON`,
        'The merchant UCP manifest was malformed.',
        false,
        { manifestUrl }
      );
    }

    return this.parseManifest(raw, manifestUrl);
  }

  /**
   * Validate and normalize an untrusted manifest document into a typed
   * {@link UCPManifest}. Tolerates both `paymentHandlers`/`payment_handlers`
   * and `checkoutUrl`/`checkout_url` spellings, drops malformed handler
   * entries, and rejects a document missing a usable `version`.
   */
  private parseManifest(raw: unknown, sourceUrl: string): UCPManifest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP manifest at ${sourceUrl} is not a JSON object`,
        'The merchant UCP manifest was malformed.',
        false,
        { sourceUrl }
      );
    }

    const obj = raw as Record<string, unknown>;

    const version = typeof obj.version === 'string' ? obj.version : undefined;
    if (!version) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP manifest at ${sourceUrl} is missing a string "version"`,
        'The merchant UCP manifest was malformed.',
        false,
        { sourceUrl }
      );
    }

    const capabilities = Array.isArray(obj.capabilities)
      ? obj.capabilities.filter((c): c is string => typeof c === 'string')
      : [];

    const rawHandlers = Array.isArray(obj.paymentHandlers)
      ? obj.paymentHandlers
      : Array.isArray(obj.payment_handlers)
        ? obj.payment_handlers
        : Array.isArray(obj.handlers)
          ? obj.handlers
          : [];
    const paymentHandlers = rawHandlers
      .map((h) => this.parseHandler(h))
      .filter((h): h is UCPPaymentHandler => h !== null);

    const checkoutUrl =
      typeof obj.checkoutUrl === 'string'
        ? obj.checkoutUrl
        : typeof obj.checkout_url === 'string'
          ? obj.checkout_url
          : undefined;

    return {
      version,
      name: typeof obj.name === 'string' ? obj.name : undefined,
      capabilities,
      paymentHandlers,
      checkoutUrl,
    };
  }

  /** Validate a single untrusted handler entry; returns null if unusable. */
  private parseHandler(raw: unknown): UCPPaymentHandler | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name !== 'string') return null;
    return {
      id: typeof obj.id === 'string' ? obj.id : obj.name,
      name: obj.name,
      version: typeof obj.version === 'string' ? obj.version : undefined,
      config:
        obj.config && typeof obj.config === 'object'
          ? (obj.config as Record<string, any>)
          : {},
    };
  }

  /**
   * Confirm the manifest advertises the `checkout` capability and the Veridex
   * payment handler. Throws {@link AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED}
   * when the merchant cannot transact with a Veridex agent.
   */
  private assertManifestSupportsVeridex(manifest: UCPManifest, manifestUrl: string): void {
    const { agreed } = this.negotiator.negotiate(manifest.capabilities);
    if (!agreed.includes(REQUIRED_CAPABILITY)) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP manifest does not advertise the "${REQUIRED_CAPABILITY}" capability. Advertised: ${manifest.capabilities.join(', ') || '(none)'}`,
        'The merchant does not support agent checkout via UCP.',
        false,
        { manifestUrl, capabilities: manifest.capabilities }
      );
    }

    const hasVeridexHandler = manifest.paymentHandlers.some((h) => h.name === VERIDEX_HANDLER_NAME);
    if (!hasVeridexHandler) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `Merchant does not advertise Veridex payments in its manifest. Available handlers: ${manifest.paymentHandlers.map((h) => h.name).join(', ') || '(none)'}`,
        'The merchant needs to add dev.veridex.passkey_payment as a payment handler.',
        false,
        { manifestUrl }
      );
    }
  }

  /**
   * Resolve the checkout-creation endpoint from a validated manifest. A
   * manifest-declared `checkoutUrl` is honored (resolved relative to the
   * manifest origin and constrained to it); otherwise the manifest URL itself
   * is used, preserving the prior behavior.
   */
  private resolveCheckoutEndpoint(manifest: UCPManifest, manifestUrl: string): string {
    if (!manifest.checkoutUrl) return manifestUrl;

    const manifestOrigin = new URL(manifestUrl).origin;
    let resolved: URL;
    try {
      resolved = new URL(manifest.checkoutUrl, manifestOrigin);
    } catch {
      return manifestUrl;
    }

    if (resolved.origin !== manifestOrigin) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP manifest checkout endpoint (${resolved.origin}) is a different origin than the manifest (${manifestOrigin})`,
        'The merchant checkout endpoint was cross-origin and was rejected for safety.',
        false,
        { manifestUrl, checkoutOrigin: resolved.origin }
      );
    }

    return resolved.toString();
  }

  private async createCheckout(url: string): Promise<UCPCheckoutResponse> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        consumer_platform: 'veridex-agent',
        supported_handlers: [VERIDEX_HANDLER_NAME],
      }),
    });

    if (!response.ok) {
      throw new Error(`UCP checkout creation failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private async createCredential(
    session: any,
    handler: UCPPaymentHandler,
    checkout: UCPCheckoutResponse,
    preDecryptedWallet?: ethers.Wallet
  ): Promise<string> {
    const wallet = preDecryptedWallet ?? new ethers.Wallet(session.encryptedPrivateKey);

    const { recipient_address, chain_id, token_address } = handler.config;
    const amount = handler.config.amount || checkout.total.amount;

    const payload = {
      recipient: recipient_address,
      chain_id,
      token: token_address,
      amount,
      checkout_id: checkout.checkout_id,
      nonce: Date.now(),
      timestamp: Date.now(),
    };

    const signature = await wallet.signMessage(JSON.stringify(payload));

    return JSON.stringify({
      payload,
      signature,
      signer: wallet.address,
      key_hash: session.keyHash,
    });
  }

  private async completeCheckout(url: string, credential: string): Promise<void> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_credential: {
          handler: VERIDEX_HANDLER_NAME,
          data: credential,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`UCP checkout completion failed: ${response.status} ${body}`);
    }
  }

  private parseUSDAmount(amount: string, currency: string): number {
    const parsed = parseFloat(amount);
    if (Number.isNaN(parsed)) return 0;
    if (currency.toUpperCase() === 'USD') return parsed;
    // For non-USD currencies, rough conversion (should use oracle in production)
    return parsed;
  }
}
