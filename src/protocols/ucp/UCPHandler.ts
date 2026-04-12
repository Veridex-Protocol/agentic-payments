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
import { CostEstimate, ProtocolContext, ProtocolName } from '../base/types';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';
import { ethers } from 'ethers';

interface UCPManifest {
  id: string;
  name: string;
  capabilities: string[];
  paymentHandlers: UCPPaymentHandler[];
}

interface UCPPaymentHandler {
  id: string;
  name: string;
  version?: string;
  config: Record<string, any>;
}

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

    // Determine the checkout/manifest URL
    let checkoutUrl: string;

    if (originalResponse?.headers.has('x-ucp-initiation-url')) {
      checkoutUrl = originalResponse.headers.get('x-ucp-initiation-url')!;
    } else {
      const linkHeader = originalResponse?.headers.get('link');
      if (linkHeader) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="ucp-manifest"/);
        if (match) {
          checkoutUrl = match[1];
        } else {
          checkoutUrl = `${new URL(url).origin}/.well-known/ucp`;
        }
      } else {
        checkoutUrl = `${new URL(url).origin}/.well-known/ucp`;
      }
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
    if (isNaN(parsed)) return 0;
    if (currency.toUpperCase() === 'USD') return parsed;
    // For non-USD currencies, rough conversion (should use oracle in production)
    return parsed;
  }
}
