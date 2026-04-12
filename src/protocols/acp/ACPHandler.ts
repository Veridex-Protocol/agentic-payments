/**
 * @packageDocumentation
 * @module ACPHandler
 * @description
 * Protocol handler for ACP (Agentic Commerce Protocol) — OpenAI/Stripe.
 *
 * ACP uses a cart + checkout model where:
 * 1. Server responds with `openai-acp-version` header or `x-acp-checkout-url`
 * 2. Agent fetches cart details from the checkout URL
 * 3. Agent generates a payment token backed by session key
 * 4. Agent completes checkout and re-fetches the original resource
 *
 * The payment token is a base64url-encoded JSON payload containing cart ID,
 * amount, session key hash, and a signature — compatible with Stripe's
 * token format for ACP merchants.
 */

import { ProtocolHandler } from '../base/ProtocolHandler';
import { CostEstimate, ProtocolContext, ProtocolName } from '../base/types';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';
import { ethers } from 'ethers';

interface ACPCart {
  id: string;
  items: ACPCartItem[];
  total: number;
  currency: string;
  merchant: {
    id: string;
    name: string;
  };
  checkout_url: string;
  expires_at?: string;
}

interface ACPCartItem {
  id: string;
  name: string;
  quantity: number;
  unit_price: number;
  currency: string;
}

export class ACPHandler extends ProtocolHandler {
  readonly protocolName: ProtocolName = 'acp';
  readonly priority = 90;

  async canHandle(response: Response, _url: string): Promise<boolean> {
    return (
      response.headers.has('openai-acp-version') ||
      response.headers.has('x-acp-checkout-url')
    );
  }

  async handle(
    url: string,
    options: RequestInit,
    context: ProtocolContext,
    originalResponse?: Response
  ): Promise<Response> {
    if (!originalResponse) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'ACP handler requires the original response',
        'Ensure the original response is passed to the handler.',
        false
      );
    }

    const { session } = context;

    // 1. Get checkout URL
    const checkoutUrl =
      originalResponse.headers.get('x-acp-checkout-url') ||
      originalResponse.headers.get('location');

    if (!checkoutUrl) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'ACP checkout URL not found in response headers',
        'The server should include x-acp-checkout-url or location header.',
        false
      );
    }

    // 2. Fetch cart details
    const cart = await this.getCart(checkoutUrl);

    // 3. Check spending limits
    const amountUSD = cart.currency.toUpperCase() === 'USD' ? cart.total : cart.total;
    const remainingDaily = session.config.dailyLimitUSD - session.metadata.dailySpentUSD;

    if (amountUSD > session.config.perTransactionLimitUSD) {
      throw AgentPaymentError.fromLimitExceeded(
        `ACP cart total $${amountUSD.toFixed(2)} exceeds per-transaction limit`,
        { amountUSD, cartId: cart.id }
      );
    }
    if (amountUSD > remainingDaily) {
      throw AgentPaymentError.fromLimitExceeded(
        `ACP cart total $${amountUSD.toFixed(2)} exceeds remaining daily limit $${remainingDaily.toFixed(2)}`,
        { amountUSD, remainingDaily, cartId: cart.id }
      );
    }

    // 4. Generate payment token (pass pre-decrypted wallet)
    const token = await this.generatePaymentToken(cart, session, context.signerWallet);

    // 5. Complete checkout
    await this.completeCheckout(checkoutUrl, cart.id, token);

    // 6. Re-fetch original resource (now authorized)
    return fetch(url, options);
  }

  async estimateCost(response: Response): Promise<CostEstimate> {
    const checkoutUrl = response.headers.get('x-acp-checkout-url');
    if (!checkoutUrl) {
      return {
        amountUSD: 0,
        amountRaw: '0',
        token: 'USD',
        chain: 0,
        scheme: 'acp',
        confidence: 0,
        description: 'ACP checkout URL not found',
      };
    }

    try {
      const cart = await this.getCart(checkoutUrl);
      return {
        amountUSD: cart.total,
        amountRaw: String(Math.round(cart.total * 100)),
        token: cart.currency,
        chain: 0,
        scheme: 'acp',
        confidence: 0.95,
        description: `ACP checkout: ${cart.items.length} item(s) from ${cart.merchant.name} — $${cart.total.toFixed(2)}`,
      };
    } catch {
      return {
        amountUSD: 0,
        amountRaw: '0',
        token: 'USD',
        chain: 0,
        scheme: 'acp',
        confidence: 0,
        description: 'Failed to fetch ACP cart',
      };
    }
  }

  private async getCart(checkoutUrl: string): Promise<ACPCart> {
    const response = await fetch(checkoutUrl, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        `Failed to fetch ACP cart: ${response.status}`,
        'The ACP checkout endpoint returned an error.',
        true
      );
    }

    return response.json();
  }

  private async generatePaymentToken(
    cart: ACPCart,
    session: any,
    preDecryptedWallet?: ethers.Wallet
  ): Promise<string> {
    const wallet = preDecryptedWallet ?? new ethers.Wallet(session.encryptedPrivateKey);

    const payload = {
      cart_id: cart.id,
      amount_cents: Math.round(cart.total * 100),
      currency: cart.currency,
      merchant_id: cart.merchant.id,
      session_key_hash: session.keyHash,
      timestamp: Date.now(),
      expires_at: Date.now() + 5 * 60 * 1000, // 5 min validity
    };

    const message = JSON.stringify(payload);
    const signature = await wallet.signMessage(message);

    const tokenPayload = { ...payload, signature, signer: wallet.address };
    return Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
  }

  private async completeCheckout(
    checkoutUrl: string,
    cartId: string,
    paymentToken: string
  ): Promise<void> {
    const response = await fetch(`${checkoutUrl}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart_id: cartId,
        payment_method: 'veridex_session_key',
        payment_token: paymentToken,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        `ACP checkout completion failed: ${response.status} ${body}`,
        'Payment was rejected by the ACP merchant.',
        false
      );
    }
  }
}
