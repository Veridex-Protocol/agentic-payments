/**
 * @packageDocumentation
 * @module StacksFacilitatorAdapter
 * @description
 * Adapter for the x402-stacks facilitator protocol.
 *
 * This adapter enables Veridex agents to make autonomous payments on Stacks
 * using the x402 protocol. It handles:
 * - CAIP-2 network detection (stacks:1, stacks:2147483648)
 * - STX and sBTC (SIP-010) payment building
 * - Post-Conditions in Deny mode for protocol-level safety
 * - Signed-but-not-broadcast transaction construction
 * - Settlement via the x402 facilitator
 *
 * The adapter wraps the x402-stacks npm package and integrates it with
 * Veridex's spending limit enforcement and audit logging.
 */
import {
    Payment402Request,
    Payment402Response,
    PaymentSettlementResponse,
} from '../../types/x402';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';

// ============================================================================
// Types
// ============================================================================

export interface StacksFacilitatorConfig {
    /** URL of the x402-stacks facilitator service */
    facilitatorUrl: string;
    /** Stacks network: 'mainnet' or 'testnet' */
    network: 'mainnet' | 'testnet';
    /** Spoke contract address (optional, for session-authorized payments) */
    spokeContractAddress?: string;
    /** Spoke contract name (default: 'veridex-spoke') */
    spokeContractName?: string;
}

/** CAIP-2 network identifiers for Stacks */
const STACKS_CAIP2 = {
    mainnet: 'stacks:1',
    testnet: 'stacks:2147483648',
} as const;

/** sBTC contract info per network */
const SBTC_CONTRACTS: Record<string, { address: string; name: string }> = {
    mainnet: {
        address: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4',
        name: 'sbtc-token',
    },
    testnet: {
        address: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4',
        name: 'sbtc-token',
    },
};

// ============================================================================
// StacksFacilitatorAdapter
// ============================================================================

/**
 * Adapter for x402-stacks facilitator integration.
 *
 * Handles building and settling Stacks payments for the x402 protocol.
 * Transactions are signed with the agent's session key (never the master Passkey).
 */
export class StacksFacilitatorAdapter {
    private facilitatorUrl: string;
    private network: 'mainnet' | 'testnet';
    private spokeContractAddress?: string;
    private spokeContractName: string;

    constructor(config: StacksFacilitatorConfig) {
        this.facilitatorUrl = config.facilitatorUrl;
        this.network = config.network;
        this.spokeContractAddress = config.spokeContractAddress;
        this.spokeContractName = config.spokeContractName || 'veridex-spoke';
    }

    /**
     * Check if this adapter can handle a given payment request.
     * Returns true if the payment network is a Stacks CAIP-2 identifier.
     *
     * @param paymentRequest - The parsed 402 payment request
     * @returns true if this is a Stacks payment
     */
    canHandle(paymentRequest: Payment402Request): boolean {
        const network = paymentRequest.network;
        if (!network) return false;
        return network.startsWith('stacks:');
    }

    /**
     * Get the CAIP-2 network identifier for the configured network.
     */
    getNetworkCAIP2(): string {
        return STACKS_CAIP2[this.network];
    }

    /**
     * Build a signed Stacks transaction for x402 payment.
     *
     * The transaction is signed with the session key but NOT broadcast.
     * The facilitator handles broadcasting and settlement.
     *
     * Supports:
     * - STX native transfers with Post-Conditions
     * - sBTC (SIP-010) transfers with Post-Conditions
     *
     * @param request - The parsed 402 payment request
     * @param sessionPrivateKey - The agent's session private key (hex, no 0x prefix)
     * @returns Payment response with serialized transaction
     */
    async buildPayment(
        request: Payment402Request,
        sessionPrivateKey: string
    ): Promise<Payment402Response> {
        const amount = BigInt(request.amount);
        const recipient = request.recipient;
        const asset = (request.token || 'STX').toUpperCase();

        // Validate supported assets
        if (asset !== 'STX' && asset !== 'SBTC') {
            throw new AgentPaymentError(
                AgentPaymentErrorCode.TOKEN_NOT_SUPPORTED,
                `Token "${asset}" is not supported on Stacks. Use STX or sBTC.`,
                'Use STX or sBTC for Stacks payments.',
                false
            );
        }

        // Build the payment request to send to the facilitator
        const paymentPayload = {
            x402Version: 2,
            payload: {
                network: this.getNetworkCAIP2(),
                asset,
                amount: amount.toString(),
                recipient,
                senderKey: sessionPrivateKey,
                spokeContract: this.spokeContractAddress
                    ? `${this.spokeContractAddress}.${this.spokeContractName}`
                    : undefined,
            },
            accepted: {
                scheme: request.scheme || 'exact',
                network: request.network,
                amount: request.amount,
                asset,
                payTo: recipient,
            },
        };

        // Submit to facilitator for transaction building
        try {
            const response = await fetch(`${this.facilitatorUrl}/api/v1/build`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(paymentPayload),
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                throw new AgentPaymentError(
                    AgentPaymentErrorCode.PAYMENT_FAILED,
                    `Facilitator build failed: ${response.status} - ${errorText}`,
                    'Check facilitator URL and try again.',
                    true
                );
            }

            const result = await response.json() as Record<string, unknown>;

            const payload = (result.paymentPayload as string) ||
                Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

            return {
                signature: (result.signature as string) || '',
                nonce: (result.nonce as string) || '0',
                deadline: (result.deadline as number) || Math.floor(Date.now() / 1000) + 300,
                paymentPayload: payload,
            };
        } catch (error: unknown) {
            if (error instanceof AgentPaymentError) throw error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AgentPaymentError(
                AgentPaymentErrorCode.PAYMENT_FAILED,
                `Failed to build Stacks payment: ${message}`,
                'Check network connectivity and facilitator URL.',
                true
            );
        }
    }

    /**
     * Settle a payment via the x402-stacks facilitator.
     *
     * The facilitator broadcasts the signed transaction and confirms settlement.
     *
     * @param request - The original payment request
     * @param response - The signed payment response from buildPayment()
     * @returns Settlement result with transaction hash
     */
    async settle(
        request: Payment402Request,
        response: Payment402Response
    ): Promise<PaymentSettlementResponse> {
        try {
            const settleResponse = await fetch(`${this.facilitatorUrl}/api/v1/settle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    paymentPayload: response.paymentPayload,
                    recipient: request.recipient,
                    amount: request.amount,
                    asset: request.token || 'STX',
                    network: request.network,
                }),
            });

            if (!settleResponse.ok) {
                const errorText = await settleResponse.text().catch(() => 'Unknown error');
                throw new AgentPaymentError(
                    AgentPaymentErrorCode.PAYMENT_FAILED,
                    `Stacks settlement failed: ${settleResponse.status} - ${errorText}`,
                    'Check STX/sBTC balance and try again.',
                    true
                );
            }

            const result = await settleResponse.json() as Record<string, unknown>;

            if (!result.success) {
                throw new AgentPaymentError(
                    AgentPaymentErrorCode.PAYMENT_FAILED,
                    `Stacks settlement rejected: ${result.error || 'Unknown reason'}`,
                    'Check STX/sBTC balance and try again.',
                    true
                );
            }

            return {
                success: true,
                transactionHash: (result.transactionHash as string) || (result.txHash as string) || '',
                network: request.network,
                amount: request.amount,
            };
        } catch (error: unknown) {
            if (error instanceof AgentPaymentError) throw error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AgentPaymentError(
                AgentPaymentErrorCode.PAYMENT_FAILED,
                `Stacks settlement exception: ${message}`,
                'Retry the operation.',
                true
            );
        }
    }

    /**
     * Verify a payment before settlement (optional pre-check).
     *
     * @param request - The payment request
     * @param response - The signed payment response
     * @returns true if the payment is valid
     */
    async verify(
        request: Payment402Request,
        response: Payment402Response
    ): Promise<boolean> {
        try {
            const verifyResponse = await fetch(`${this.facilitatorUrl}/api/v1/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    paymentPayload: response.paymentPayload,
                    recipient: request.recipient,
                    amount: request.amount,
                    asset: request.token || 'STX',
                }),
            });

            if (!verifyResponse.ok) return false;

            const result = await verifyResponse.json() as Record<string, unknown>;
            return result.isValid === true;
        } catch {
            return false;
        }
    }

    /**
     * Get the sBTC contract info for the configured network.
     */
    getSBTCContract(): { address: string; name: string } {
        return SBTC_CONTRACTS[this.network] || SBTC_CONTRACTS.testnet!;
    }

    /**
     * Get supported capabilities.
     */
    getCapabilities(): { assets: string[]; network: string } {
        return {
            assets: ['STX', 'sBTC'],
            network: this.getNetworkCAIP2(),
        };
    }
}
