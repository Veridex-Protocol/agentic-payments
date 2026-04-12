/**
 * @packageDocumentation
 * @module AP2Handler
 * @description
 * Protocol handler for AP2 (Agent-to-Pay) — Google's delegation mandate protocol.
 *
 * AP2 uses a mandate-based model where:
 * 1. Server responds with `x-ap2-mandate-url` header
 * 2. Agent fetches mandate details (spending limits, categories, expiry)
 * 3. Agent validates mandate fits within session constraints
 * 4. Agent maps Veridex session key to AP2 mandate format
 * 5. Agent fulfills mandate with signed credential
 *
 * The MandateMapper translates between Veridex Session Keys (USKS)
 * and AP2's mandate format, enabling seamless interop.
 */

import { ProtocolHandler } from '../base/ProtocolHandler';
import { CostEstimate, ProtocolContext, ProtocolName } from '../base/types';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';
import { ethers } from 'ethers';

export interface AP2Mandate {
  version: string;
  mandate_id: string;
  cart_mandate: {
    max_value: {
      amount: number;
      currency: string;
    };
    allowed_categories: string[];
    expires_at: string;
  };
  payment_mandate: {
    provider: string;
    credential_type: string;
    credential?: Record<string, string>;
  };
  intent_mandate: {
    source: string;
    verified_at: string;
    description?: string;
  };
  fulfillment_url: string;
}

export class AP2Handler extends ProtocolHandler {
  readonly protocolName: ProtocolName = 'ap2';
  readonly priority = 80;

  async canHandle(response: Response, _url: string): Promise<boolean> {
    return (
      response.headers.has('x-ap2-mandate-url') ||
      response.headers.has('x-google-a2a-mandate')
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
        'AP2 handler requires the original response',
        'Ensure the original response is passed to the handler.',
        false
      );
    }

    const { session } = context;

    // 1. Get mandate URL
    const mandateUrl =
      originalResponse.headers.get('x-ap2-mandate-url') ||
      originalResponse.headers.get('x-google-a2a-mandate');

    if (!mandateUrl) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'AP2 mandate URL not found in response headers',
        'The server should include x-ap2-mandate-url header.',
        false
      );
    }

    // 2. Fetch mandate details
    const mandate = await this.getMandate(mandateUrl);

    // 3. Validate mandate against session constraints
    this.validateMandateAgainstSession(mandate, session);

    // 4. Fulfill mandate with Veridex credential (pass pre-decrypted wallet)
    const fulfillment = await this.fulfillMandate(mandate, session, context.signerWallet);

    // 5. Submit fulfillment
    const fulfillmentResponse = await fetch(mandate.fulfillment_url || mandateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fulfillment),
    });

    if (!fulfillmentResponse.ok) {
      const body = await fulfillmentResponse.text().catch(() => '');
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        `AP2 mandate fulfillment failed: ${fulfillmentResponse.status} ${body}`,
        'The AP2 mandate could not be fulfilled.',
        true
      );
    }

    // 6. Re-fetch original resource
    return fetch(url, options);
  }

  async estimateCost(response: Response): Promise<CostEstimate> {
    const mandateUrl = response.headers.get('x-ap2-mandate-url');
    if (!mandateUrl) {
      return {
        amountUSD: 0,
        amountRaw: '0',
        token: 'USD',
        chain: 0,
        scheme: 'ap2',
        confidence: 0,
        description: 'AP2 mandate URL not found',
      };
    }

    try {
      const mandate = await this.getMandate(mandateUrl);
      const amount = mandate.cart_mandate.max_value.amount;
      return {
        amountUSD: amount,
        amountRaw: String(Math.round(amount * 100)),
        token: mandate.cart_mandate.max_value.currency,
        chain: 0,
        scheme: 'ap2',
        confidence: 0.8,
        description: `AP2 mandate: up to $${amount.toFixed(2)} ${mandate.cart_mandate.max_value.currency}`,
      };
    } catch {
      return {
        amountUSD: 0,
        amountRaw: '0',
        token: 'USD',
        chain: 0,
        scheme: 'ap2',
        confidence: 0,
        description: 'Failed to fetch AP2 mandate',
      };
    }
  }

  private async getMandate(url: string): Promise<AP2Mandate> {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        `Failed to fetch AP2 mandate: ${response.status}`,
        'The AP2 mandate endpoint returned an error.',
        true
      );
    }

    return response.json();
  }

  private validateMandateAgainstSession(mandate: AP2Mandate, session: any): void {
    const mandateAmount = mandate.cart_mandate.max_value.amount;
    const remainingDaily = session.config.dailyLimitUSD - session.metadata.dailySpentUSD;

    if (mandateAmount > session.config.perTransactionLimitUSD) {
      throw AgentPaymentError.fromLimitExceeded(
        `AP2 mandate max value $${mandateAmount} exceeds per-transaction limit $${session.config.perTransactionLimitUSD}`,
        { mandateAmount }
      );
    }

    if (mandateAmount > remainingDaily) {
      throw AgentPaymentError.fromLimitExceeded(
        `AP2 mandate max value $${mandateAmount} exceeds remaining daily limit $${remainingDaily.toFixed(2)}`,
        { mandateAmount, remainingDaily }
      );
    }

    const mandateExpiry = new Date(mandate.cart_mandate.expires_at).getTime();
    if (mandateExpiry > session.config.expiryTimestamp) {
      console.warn('[AP2] Mandate expires after session — capping to session expiry');
    }
  }

  private async fulfillMandate(mandate: AP2Mandate, session: any, preDecryptedWallet?: ethers.Wallet): Promise<Record<string, any>> {
    // Use pre-decrypted wallet if available, otherwise fall back to raw hex (legacy/dev)
    const wallet = preDecryptedWallet ?? new ethers.Wallet(session.encryptedPrivateKey);

    const fulfillment = {
      mandate_id: mandate.mandate_id,
      provider: 'veridex',
      credential_type: 'session_key',
      credential: {
        key_hash: session.keyHash,
        public_key: session.publicKey,
        signer: wallet.address,
      },
      cart_mandate_response: {
        max_value: {
          amount: Math.min(
            mandate.cart_mandate.max_value.amount,
            session.config.dailyLimitUSD - session.metadata.dailySpentUSD
          ),
          currency: mandate.cart_mandate.max_value.currency,
        },
        allowed_categories: mandate.cart_mandate.allowed_categories,
        expires_at: new Date(
          Math.min(
            new Date(mandate.cart_mandate.expires_at).getTime(),
            session.config.expiryTimestamp
          )
        ).toISOString(),
      },
      intent_mandate_response: {
        source: 'user_authorization',
        verified_at: new Date(session.createdAt || Date.now()).toISOString(),
      },
      timestamp: Date.now(),
      signature: '',
    };

    // Sign the fulfillment
    fulfillment.signature = await wallet.signMessage(JSON.stringify({
      mandate_id: fulfillment.mandate_id,
      max_value: fulfillment.cart_mandate_response.max_value,
      timestamp: fulfillment.timestamp,
    }));

    return fulfillment;
  }
}

/**
 * Utility class for mapping between Veridex sessions and AP2 mandates.
 */
export class MandateMapper {
  /**
   * Convert a Veridex Session Key to AP2 mandate format.
   */
  static sessionToMandate(session: any): Omit<AP2Mandate, 'mandate_id' | 'fulfillment_url'> {
    return {
      version: '2026-01',
      cart_mandate: {
        max_value: {
          amount: session.config.dailyLimitUSD,
          currency: 'USD',
        },
        allowed_categories: session.config.allowedCategories || ['*'],
        expires_at: new Date(session.config.expiryTimestamp).toISOString(),
      },
      payment_mandate: {
        provider: 'veridex',
        credential_type: 'session_key',
        credential: {
          key_hash: session.keyHash,
          public_key: session.publicKey,
        },
      },
      intent_mandate: {
        source: 'user_authorization',
        verified_at: new Date(session.createdAt || Date.now()).toISOString(),
      },
    };
  }
}
