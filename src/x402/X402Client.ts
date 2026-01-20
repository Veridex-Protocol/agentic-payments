/**
 * x402 Client
 * 
 * Handles HTTP 402 Payment Required responses automatically.
 * Implements the Coinbase x402 protocol for machine-to-machine payments.
 * 
 * Flow:
 * 1. Client makes HTTP request to resource server
 * 2. Server responds with 402 + PAYMENT-REQUIRED header
 * 3. Client parses payment requirements
 * 4. Client signs payment authorization (ERC-3009)
 * 5. Client retries request with PAYMENT-SIGNATURE header
 * 6. Server verifies/settles payment and returns resource
 * 
 * Reference: https://github.com/coinbase/x402
 */

import { PaymentParser } from './PaymentParser';
import { PaymentSigner } from './PaymentSigner';
import { NonceManager } from './NonceManager';
import { SessionKeyManager } from '../session/SessionKeyManager';
import { VeridexSDK } from '@veridex/sdk';
import { StoredSession } from '../session/SessionStorage';
import { UCPClient } from '../ucp/UCPClient';
import {
  Payment402Request,
  PaymentSettlementResponse,
  X402ClientConfig,
} from '../types/x402';
import { AgentPaymentError, AgentPaymentErrorCode } from '../types/errors';

// Header names as per x402 spec
const HEADER_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED';
const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE';
const HEADER_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE';
const HEADER_UCP_INITIATION = 'x-ucp-initiation-url';

// Default configuration
const DEFAULT_CONFIG: Required<X402ClientConfig> = {
  defaultFacilitator: '',
  paymentTimeoutMs: 30000,
  maxRetries: 1,
  verifyBeforePay: false,
};

export class X402Client {
  private parser: PaymentParser;
  private signer: PaymentSigner;
  private nonceManager: NonceManager;
  private ucpClient: UCPClient;
  private config: Required<X402ClientConfig>;

  constructor(
    private sessionManager: SessionKeyManager,
    public coreSDK: VeridexSDK,
    config: X402ClientConfig = {}
  ) {
    this.parser = new PaymentParser();
    this.signer = new PaymentSigner();
    this.nonceManager = new NonceManager();
    this.ucpClient = new UCPClient(coreSDK);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Handle a fetch request with automatic 402 payment handling.
   * 
   * This is the main entry point for agent HTTP requests. It:
   * 1. Makes the initial request
   * 2. If 402 is returned, parses payment requirements
   * 3. Validates spending limits
   * 4. Signs the payment authorization
   * 5. Retries the request with payment proof
   * 
   * @param url - Request URL
   * @param options - Standard fetch options
   * @param session - Active session for payment signing
   * @returns Response from the server (after payment if needed)
   */
  async handleFetch(
    url: string,
    options: RequestInit = {},
    session: StoredSession
  ): Promise<Response> {
    // Make initial request
    const initialResponse = await this.performFetch(url, options);

    // Check if payment is required
    if (initialResponse.status !== 402) {
      return initialResponse;
    }

    // Extract headers for parsing
    const headers = this.extractHeaders(initialResponse);

    // Check for UCP checkout flow first
    const ucpCheckoutUrl = headers[HEADER_UCP_INITIATION.toLowerCase()] ||
      headers['x-ucp-initiation-url'];

    if (ucpCheckoutUrl) {
      return await this.handleUCPFlow(ucpCheckoutUrl, url, options, session);
    }

    // Standard x402 flow
    return await this.handleX402Flow(url, options, session, headers);
  }

  /**
   * Handle standard x402 payment flow.
   */
  private async handleX402Flow(
    url: string,
    options: RequestInit,
    session: StoredSession,
    headers: Record<string, string>
  ): Promise<Response> {
    // Parse payment requirements
    const paymentRequest = this.parser.parseHeaders(headers);

    if (!paymentRequest) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.X402_PARSE_ERROR,
        'Failed to parse x402 payment requirements from 402 response',
        'The server returned a 402 but the PAYMENT-REQUIRED header was missing or invalid.',
        false
      );
    }

    // Calculate USD value for limit check
    // Note: In production, query price oracle for accurate conversion
    const amountUSD = this.estimateUSDValue(paymentRequest);

    // Check session spending limits
    const limitResult = this.sessionManager.checkLimits(session, amountUSD);
    if (!limitResult.allowed) {
      throw AgentPaymentError.fromLimitExceeded(
        limitResult.reason || 'Transaction exceeds session limits',
        {
          requestedAmount: paymentRequest.amount,
          requestedAmountUSD: amountUSD,
          remainingDailyLimit: limitResult.remainingDailyLimitUSD,
        }
      );
    }

    // Sign the payment authorization
    const paymentResponse = await this.signer.sign(paymentRequest, session);

    // Record spending BEFORE making the payment
    // This prevents double-spending if the retry succeeds
    await this.sessionManager.recordSpending(session, amountUSD);

    // Retry request with payment proof
    try {
      const response = await this.retryWithPayment(url, options, paymentResponse.paymentPayload);

      // Parse settlement response if present
      const settlementHeader = response.headers.get(HEADER_PAYMENT_RESPONSE);
      if (settlementHeader) {
        const settlement = this.parseSettlementResponse(settlementHeader);
        if (!settlement.success) {
          console.warn('[x402] Payment settlement reported failure:', settlement.error);
        }
      }

      return response;
    } catch (error) {
      // If payment failed, we should ideally refund the spending record
      // But for safety, we leave it recorded (conservative approach)
      throw error;
    }
  }

  /**
   * Handle UCP checkout flow (discovered via 402 response).
   */
  private async handleUCPFlow(
    checkoutUrl: string,
    originalUrl: string,
    originalOptions: RequestInit,
    session: StoredSession
  ): Promise<Response> {
    try {
      // Initiate UCP checkout
      await this.ucpClient.initiateCheckoutFlow(checkoutUrl, session, originalOptions);

      // UCP checkout completed, retry the original request
      // The server should now recognize the satisfied payment
      return await this.performFetch(originalUrl, originalOptions);
    } catch (error: any) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED,
        `UCP checkout failed: ${error.message}`,
        'The Universal Commerce Protocol checkout could not be completed. Try again or use a different payment method.',
        true,
        { checkoutUrl, originalError: error }
      );
    }
  }

  /**
   * Retry a request with payment signature attached.
   */
  private async retryWithPayment(
    url: string,
    options: RequestInit,
    paymentPayload: string
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set(HEADER_PAYMENT_SIGNATURE, paymentPayload);

    const retryOptions: RequestInit = {
      ...options,
      headers,
    };

    const response = await this.performFetch(url, retryOptions);

    // If we still get a 402, the payment was rejected
    if (response.status === 402) {
      const errorHeaders = this.extractHeaders(response);
      const paymentRequired = errorHeaders[HEADER_PAYMENT_REQUIRED.toLowerCase()];

      let errorMessage = 'Payment was rejected by the server';
      try {
        if (paymentRequired) {
          const decoded = JSON.parse(Buffer.from(paymentRequired, 'base64').toString());
          errorMessage = decoded.error || errorMessage;
        }
      } catch {
        // Ignore parse errors
      }

      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        errorMessage,
        'The payment signature was rejected. This may be due to insufficient balance, invalid signature, or expired deadline.',
        false
      );
    }

    return response;
  }

  /**
   * Perform a fetch request (abstracted for testing).
   */
  private async performFetch(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.paymentTimeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Extract headers from response as plain object.
   */
  private extractHeaders(response: Response): Record<string, string> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return headers;
  }

  /**
   * Parse the settlement response from PAYMENT-RESPONSE header.
   */
  private parseSettlementResponse(headerValue: string): PaymentSettlementResponse {
    try {
      const decoded = Buffer.from(headerValue, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    } catch {
      return {
        success: false,
        network: 'unknown',
        amount: '0',
        error: 'Failed to parse settlement response',
      };
    }
  }

  /**
   * Estimate USD value of a payment request.
   * 
   * In production, this should query a price oracle.
   * For now, we assume stablecoins are 1:1 with USD.
   */
  private estimateUSDValue(request: Payment402Request): number {
    const amount = parseFloat(request.amount);

    // Check if token is a known stablecoin
    const stablecoins = ['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD'];
    const isStablecoin = stablecoins.some(
      (s) => request.token.toUpperCase().includes(s)
    );

    if (isStablecoin) {
      // Amount might be in smallest unit (e.g., 1000000 = 1 USDC)
      // If amount is very large, divide by decimals
      if (amount > 1_000_000) {
        return amount / 1_000_000; // Assuming 6 decimals
      }
      return amount;
    }

    // For non-stablecoins, we'd need a price oracle
    // For safety, reject or use a conservative estimate
    console.warn('[x402] Non-stablecoin payment detected, using 1:1 USD estimate');
    return amount > 1_000_000 ? amount / 1_000_000 : amount;
  }
}
