/**
 * x402 Protocol Types
 * 
 * Based on Coinbase x402 specification: https://github.com/coinbase/x402
 * 
 * The x402 protocol uses the HTTP 402 "Payment Required" status code
 * to enable instant, automatic stablecoin payments over HTTP.
 */

/**
 * Payment scheme types supported by x402
 * - 'exact': Transfer a specific amount (e.g., pay $1 to read an article)
 * - 'upto': Transfer up to an amount based on consumption (e.g., LLM tokens)
 */
export type X402Scheme = 'exact' | 'upto';

/**
 * Payment requirement from a 402 response.
 * This is parsed from the PAYMENT-REQUIRED header (base64 encoded JSON).
 */
export interface PaymentRequirement {
  /** Unique identifier for this payment requirement */
  id?: string;
  /** Payment scheme (e.g., 'exact') */
  scheme: X402Scheme;
  /** Network identifier (e.g., 'base-mainnet', 'ethereum-mainnet') */
  network: string;
  /** Maximum amount required for payment (in smallest unit, e.g., wei or lamports) */
  maxAmountRequired: string;
  /** Asset address (token contract) or 'native' for native currency */
  asset: string;
  /** Recipient address to receive payment */
  payTo: string;
  /** Optional facilitator URL for verification/settlement */
  facilitator?: string;
  /** Optional description of what the payment is for */
  description?: string;
  /** Optional extra data from the resource server */
  extra?: Record<string, unknown>;
}

/**
 * Full 402 response structure
 * Returned in PAYMENT-REQUIRED header as base64 JSON
 */
export interface PaymentRequiredResponse {
  /** Array of acceptable payment options */
  paymentRequirements: PaymentRequirement[];
  /** Optional error message if previous payment failed */
  error?: string;
}

/**
 * Parsed payment request for internal use
 */
export interface Payment402Request {
  /** Raw amount string (in smallest unit) */
  amount: string;
  /** Amount in human-readable format */
  amountFormatted?: string;
  /** Token address or symbol */
  token: string;
  /** Recipient address */
  recipient: string;
  /** Wormhole chain ID */
  chain: number;
  /** Network identifier string */
  network: string;
  /** Payment scheme */
  scheme: X402Scheme;
  /** Facilitator URL if present */
  facilitator?: string;
  /** Server-provided nonce (if any) */
  nonce?: string;
  /** Payment deadline timestamp */
  deadline?: number;
  /** Original payment requirement */
  original: PaymentRequirement;
}

/**
 * ERC-3009 / EIP-712 Authorization for token transfers
 * Used for 'exact' scheme on EVM networks
 */
export interface ERC3009Authorization {
  /** Address authorizing the transfer (session key) */
  from: string;
  /** Recipient address */
  to: string;
  /** Transfer value in smallest unit */
  value: string;
  /** Timestamp after which auth is valid (usually 0) */
  validAfter: number;
  /** Timestamp before which auth is valid (deadline) */
  validBefore: number;
  /** Unique nonce for replay protection */
  nonce: string;
}

/**
 * Payment payload to send with retry request.
 * Sent in PAYMENT-SIGNATURE header as base64 JSON.
 */
export interface PaymentPayload {
  /** Signature scheme version */
  x402Version: 1;
  /** Payment scheme used */
  scheme: X402Scheme;
  /** Network the payment is on */
  network: string;
  /** The payment payload specific to the scheme/network */
  payload: {
    /** EIP-712 signature */
    signature: string;
    /** Authorization details */
    authorization: ERC3009Authorization;
  };
}

/**
 * Payment response after successful settlement
 * Returned in PAYMENT-RESPONSE header as base64 JSON
 */
export interface PaymentSettlementResponse {
  /** Whether payment was successful */
  success: boolean;
  /** Transaction hash on the blockchain */
  transactionHash?: string;
  /** Network where transaction was settled */
  network: string;
  /** Amount settled */
  amount: string;
  /** Facilitator that processed the payment */
  facilitator?: string;
  /** Error message if settlement failed */
  error?: string;
}

/**
 * Internal response from payment signing
 */
export interface Payment402Response {
  /** EIP-712 signature */
  signature: string;
  /** Nonce used */
  nonce: string;
  /** Deadline timestamp */
  deadline: number;
  /** Full payment payload (base64 encoded) */
  paymentPayload: string;
  /** Transaction hash (if already submitted) */
  txHash?: string;
}

/**
 * x402 Client Configuration
 */
export interface X402ClientConfig {
  /** Default facilitator URL for verification */
  defaultFacilitator?: string;
  /** Timeout for payment operations in ms */
  paymentTimeoutMs?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Whether to verify payments before sending */
  verifyBeforePay?: boolean;
}
