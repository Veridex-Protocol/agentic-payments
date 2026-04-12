import { Facilitator, CronosNetwork } from '@crypto.com/facilitator-client';
import { 
  Payment402Request, 
  Payment402Response, 
  PaymentSettlementResponse 
} from '../../types/x402';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';

/**
 * Adapter for the Cronos x402 Facilitator.
 * 
 * This adapter allows Veridex agents to use the official Cronos Facilitator
 * for verifying and settling x402 payments on Cronos EVM.
 */
export class CronosFacilitatorAdapter {
  private facilitator: Facilitator;

  constructor(network: 'cronos-mainnet' | 'cronos-testnet' = 'cronos-testnet') {
    this.facilitator = new Facilitator({
      network: network === 'cronos-mainnet' ? CronosNetwork.CronosMainnet : CronosNetwork.CronosTestnet,
    });
  }

  /**
   * Verify a payment before settlement.
   * 
   * @param request - The internal payment request
   * @param response - The signed payment response (base64 payload)
   */
  async verify(request: Payment402Request, response: Payment402Response): Promise<boolean> {
    try {
      const body = this.facilitator.buildVerifyRequest(
        response.paymentPayload, // Base64 header (Payment402Response has paymentPayload)
        {
          scheme: request.scheme as any, // Cast to facilitator Scheme type
          network: request.network as any,
          payTo: request.recipient,
          asset: request.token as any, // Cast to facilitator Contract type
          maxAmountRequired: request.amount,
          description: request.original.description || 'Payment for resource',
          maxTimeoutSeconds: 300, // Default 5 minutes
          mimeType: 'application/json', // Default mimeType
        }
      );

      const result = await this.facilitator.verifyPayment(body);
      return result.isValid;
    } catch (error) {
      console.error('[CronosFacilitator] Verification failed:', error);
      return false;
    }
  }

  /**
   * Settle a verified payment.
   * 
   * @param request - The internal payment request
   * @param response - The signed payment response
   */
  async settle(request: Payment402Request, response: Payment402Response): Promise<PaymentSettlementResponse> {
    try {
      const body = this.facilitator.buildVerifyRequest(
        response.paymentPayload,
        {
          scheme: request.scheme as any,
          network: request.network as any,
          description: request.original.description || 'Payment for resource',
          maxTimeoutSeconds: 300, // Default 5 minutes
          mimeType: 'application/json', // Default mimeType
          payTo: request.recipient,
          asset: request.token as any,
          maxAmountRequired: request.amount,
        }
      );

      const result = await this.facilitator.settlePayment(body);

      if (result.event === 'payment.failed') {
        throw new AgentPaymentError(
          AgentPaymentErrorCode.PAYMENT_FAILED,
          `Cronos settlement failed: ${result.error}`,
          'Check token balance and approval.',
          false
        );
      }

      return {
        success: true,
        transactionHash: result.txHash,
        network: request.network,
        amount: request.amount, // Required by PaymentSettlementResponse
      };
    } catch (error: any) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        `Cronos settlement exception: ${error.message}`,
        'Retry operation.',
        true
      );
    }
  }

  /**
   * Get supported capabilities from the facilitator.
   */
  async getCapabilities() {
    return this.facilitator.getSupported();
  }
}
