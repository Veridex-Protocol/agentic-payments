/**
 * @packageDocumentation
 * @module X402Handler
 * @description
 * Protocol handler for x402 (HTTP 402 Payment Required).
 *
 * Implements the Coinbase x402 specification:
 * - Detects 402 responses with PAYMENT-REQUIRED header
 * - Parses payment requirements (exact/upto schemes)
 * - Signs ERC-3009 authorization via session key
 * - Retries request with PAYMENT-SIGNATURE header
 * - Validates settlement via PAYMENT-RESPONSE header
 *
 * Reference: https://github.com/coinbase/x402
 */

import { ProtocolHandler } from '../base/ProtocolHandler';
import { CostEstimate, PaymentSettlement, ProtocolContext, ProtocolName } from '../base/types';
import { PaymentParser } from '../../x402/PaymentParser';
import { PaymentSigner } from '../../x402/PaymentSigner';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';

const HEADER_PAYMENT_REQUIRED = 'payment-required';
const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE';
const HEADER_PAYMENT_RESPONSE = 'payment-response';

export class X402Handler extends ProtocolHandler {
  readonly protocolName: ProtocolName = 'x402';
  readonly priority = 70;

  private parser = new PaymentParser();
  private signer = new PaymentSigner();

  async canHandle(response: Response, _url: string): Promise<boolean> {
    if (response.status !== 402) return false;

    const headers = this.extractHeaders(response);
    return !!(
      headers[HEADER_PAYMENT_REQUIRED] ||
      headers['x-payment-required']
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
        AgentPaymentErrorCode.X402_PARSE_ERROR,
        'x402 handler requires the original 402 response',
        'Ensure the original response is passed to the handler.',
        false
      );
    }

    const headers = this.extractHeaders(originalResponse);
    const paymentRequest = this.parser.parseHeaders(headers);

    if (!paymentRequest) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.X402_PARSE_ERROR,
        'Failed to parse x402 payment requirements from 402 response',
        'The server returned a 402 but the PAYMENT-REQUIRED header was missing or invalid.',
        false
      );
    }

    // Estimate USD and check limits
    const amountUSD = await this.estimateUSDFromRequest(paymentRequest, context);
    const { session } = context;

    if (amountUSD > session.config.perTransactionLimitUSD) {
      throw AgentPaymentError.fromLimitExceeded(
        `x402 payment $${amountUSD.toFixed(2)} exceeds per-transaction limit $${session.config.perTransactionLimitUSD}`,
        { requestedAmount: paymentRequest.amount, amountUSD }
      );
    }

    const remainingDaily = session.config.dailyLimitUSD - session.metadata.dailySpentUSD;
    if (amountUSD > remainingDaily) {
      throw AgentPaymentError.fromLimitExceeded(
        `x402 payment $${amountUSD.toFixed(2)} exceeds remaining daily limit $${remainingDaily.toFixed(2)}`,
        { requestedAmount: paymentRequest.amount, amountUSD, remainingDaily }
      );
    }

    // Sign the payment (use pre-decrypted wallet from context)
    const paymentResponse = await this.signer.sign(paymentRequest, session, context.signerWallet);

    // Retry with payment signature
    const retryHeaders = new Headers(options.headers);
    retryHeaders.set(HEADER_PAYMENT_SIGNATURE, paymentResponse.paymentPayload);

    const retryResponse = await fetch(url, { ...options, headers: retryHeaders });

    if (retryResponse.status === 402) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'Payment was rejected by the server',
        'The payment signature was rejected. Check balance, signature validity, or deadline.',
        false
      );
    }

    return retryResponse;
  }

  async estimateCost(response: Response): Promise<CostEstimate> {
    const headers = this.extractHeaders(response);
    const paymentRequest = this.parser.parseHeaders(headers);

    if (!paymentRequest) {
      return {
        amountUSD: 0,
        amountRaw: '0',
        token: 'unknown',
        chain: 0,
        scheme: 'exact',
        confidence: 0,
        description: 'Could not parse x402 payment requirements',
      };
    }

    // Rough USD estimate (stablecoin = 1:1)
    const amountUSD = this.roughUSDEstimate(paymentRequest.amount, paymentRequest.token);

    return {
      amountUSD,
      amountRaw: paymentRequest.amount,
      token: paymentRequest.token,
      chain: paymentRequest.chain,
      scheme: paymentRequest.scheme,
      confidence: paymentRequest.token.toUpperCase().includes('USDC') ? 0.99 : 0.5,
      description: `x402 ${paymentRequest.scheme} payment of ${paymentRequest.amount} ${paymentRequest.token}`,
    };
  }

  private async estimateUSDFromRequest(
    request: { amount: string; token: string; chain: number },
    context: ProtocolContext
  ): Promise<number> {
    if (context.estimateUSD) {
      return context.estimateUSD(request.token, request.amount, request.chain);
    }
    return this.roughUSDEstimate(request.amount, request.token);
  }

  private roughUSDEstimate(amount: string, token: string): number {
    const parsed = parseFloat(amount);
    const stablecoins = ['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD'];
    const isStable = stablecoins.some(s => token.toUpperCase().includes(s));

    if (isStable) {
      return parsed > 1_000_000 ? parsed / 1_000_000 : parsed;
    }
    return parsed > 1_000_000 ? parsed / 1_000_000 : parsed;
  }

  private extractHeaders(response: Response): Record<string, string> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return headers;
  }
}
