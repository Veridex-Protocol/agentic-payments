/**
 * @packageDocumentation
 * @module ProtocolHandler
 * @description
 * Abstract base class for all payment protocol handlers.
 *
 * Each protocol (x402, UCP, ACP, AP2, AXTP) implements this interface.
 * The ProtocolDetector iterates handlers by priority to find the right one.
 *
 * Handlers are stateless — all mutable state lives in the session or context.
 */

import { StoredSession } from '../../session/SessionStorage';
import { CostEstimate, PaymentSettlement, ProtocolContext, ProtocolName } from './types';

export abstract class ProtocolHandler {
  /** Unique protocol identifier */
  abstract readonly protocolName: ProtocolName;

  /** Detection priority — higher values are checked first */
  abstract readonly priority: number;

  /**
   * Detect whether this handler can process the given HTTP response.
   * Called by ProtocolDetector in priority order.
   *
   * @param response - The initial HTTP response (may be 402 or contain protocol headers)
   * @param url - The original request URL
   * @returns true if this handler should process the response
   */
  abstract canHandle(response: Response, url: string): Promise<boolean>;

  /**
   * Execute the full payment flow for this protocol.
   *
   * @param url - Original request URL
   * @param options - Original fetch options
   * @param context - Session, relayer config, and price oracle
   * @param originalResponse - The response that triggered detection (optional)
   * @returns The final HTTP response after payment
   */
  abstract handle(
    url: string,
    options: RequestInit,
    context: ProtocolContext,
    originalResponse?: Response
  ): Promise<Response>;

  /**
   * Estimate the cost of the payment before executing.
   * Used for limit checks and user confirmation.
   *
   * @param response - The response containing payment requirements
   * @returns Cost estimate in USD and raw token amounts
   */
  abstract estimateCost(response: Response): Promise<CostEstimate>;

  /**
   * Optional: settle a payment through a facilitator or relayer.
   * Default implementation throws — override in handlers that support settlement.
   */
  async settle(
    _paymentData: unknown,
    _context: ProtocolContext
  ): Promise<PaymentSettlement> {
    throw new Error(`${this.protocolName} handler does not support direct settlement`);
  }

  /**
   * Optional: verify a payment was settled correctly.
   * Default returns true — override for on-chain verification.
   */
  async verify(
    _settlement: PaymentSettlement,
    _context: ProtocolContext
  ): Promise<boolean> {
    return true;
  }
}
