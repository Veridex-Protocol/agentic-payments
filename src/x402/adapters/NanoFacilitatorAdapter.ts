/**
 * @packageDocumentation
 * @module NanoFacilitatorAdapter
 * @description
 * Adapter for Nano (XNO) x402 settlement inside Veridex agentic-payments.
 *
 * Nano is a feeless, sub-second, serverless payment rail: there is no smart-contract
 * layer, no gas and no third-party facilitator to trust — a payment is proven by the
 * block existing on the Nano ledger. This adapter verifies and settles Nano x402
 * payments by querying the Nano node's RPC (`block_info`, `account_info`), so a paid
 * endpoint and its payer never have to pass through a custody or off-chain batching
 * layer.
 *
 * Supports both `exact` and `upto` Nano schemes.
 * Network identifier: `nano:mainnet` (and `nano:test` where a test network is reachable).
 *
 * Reuses the Nano node RPC (rpc.nano.to or any public Nano node) as the building block;
 * it never invents a Nano client from scratch.
 */

import type {
  Payment402Request,
  Payment402Response,
  PaymentSettlementResponse,
} from '../../types/x402';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';

// ---------------------------------------------------------------------------
// Network constants
// ---------------------------------------------------------------------------

/** CAIP-2-style identifiers for Nano networks. */
export const NANO_NETWORKS = {
  mainnet: 'nano:mainnet',
  test: 'nano:test',
} as const;

/** XNO raw units per whole Nano (10^30 raw in 1 XNO). */
export const NANO_RAW_PER_XNO = 10n ** 30n;

/** Default Nano node RPC endpoint (public, feeless, no auth). */
export const NANO_DEFAULT_RPC = 'https://rpc.nano.to';

/** Resolve a raw network string to a Nano network identifier. */
export function toNanoNetwork(network: string): string {
  if (network.startsWith('nano:')) return network;
  if (network === 'mainnet') return NANO_NETWORKS.mainnet;
  if (network === 'test' || network === 'testnet') return NANO_NETWORKS.test;
  return network;
}

/** Whether a network identifier refers to a Nano network. */
export function isNanoNetwork(network: string): boolean {
  return network.startsWith('nano:') || network === 'mainnet';
}

/** Convert an XNO decimal string (e.g. "0.001") to raw units. */
export function xnoToRaw(xno: string | number): string {
  const value = BigInt(Math.round(Number(xno) * 1e9)) * 10n ** 21n;
  return value.toString();
}

/** Convert raw units to an XNO decimal string. */
export function rawToXno(raw: string): string {
  const rawBig = BigInt(raw);
  const whole = rawBig / NANO_RAW_PER_XNO;
  const fraction = rawBig % NANO_RAW_PER_XNO;
  const fracStr = fraction.toString().padStart(30, '0');
  return fraction === 0n ? whole.toString() : `${whole.toString()}.${fracStr.replace(/0+$/, '')}`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface NanoFacilitatorConfig {
  /** Nano node RPC URL. Default: rpc.nano.to (public, no auth). */
  rpcUrl?: string;
  /** Nano network. Default: 'nano:mainnet'. */
  network?: string;
  /** Timeout for RPC requests in ms. Default: 15000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// NanoFacilitatorAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter that verifies and settles Nano (XNO) x402 payments against a Nano node.
 *
 * Because Nano settlement is on-ledger and feeless, `verify` and `settle` both read
 * the node — the block's existence *is* the proof of payment. There is no custodial
 * facilitator to trust, so this adapter is the entire settlement leg.
 *
 * @example
 * ```typescript
 * const nano = new NanoFacilitatorAdapter({ network: 'nano:mainnet' });
 *
 * // In a custom paywall:
 * const isValid = await nano.verify(paymentRequest, paymentResponse);
 * if (isValid) await nano.settle(paymentRequest, paymentResponse);
 * ```
 */
export class NanoFacilitatorAdapter {
  private rpcUrl: string;
  private network: string;
  private timeoutMs: number;

  constructor(config: NanoFacilitatorConfig = {}) {
    this.rpcUrl = (config.rpcUrl || NANO_DEFAULT_RPC).replace(/\/$/, '');
    this.network = config.network || NANO_NETWORKS.mainnet;
    this.timeoutMs = config.timeoutMs || 15000;
  }

  /** Whether this adapter can handle a given payment request. */
  canHandle(request: Payment402Request): boolean {
    const network = request.network || '';
    const scheme = (request.scheme as string) || '';
    return (
      isNanoNetwork(network) ||
      scheme === 'exact_nano' ||
      scheme === 'upto_nano'
    );
  }

  /** Nano network identifier for the configured network. */
  getNetwork(): string {
    return toNanoNetwork(this.network);
  }

  /**
   * Verify a Nano x402 payment by checking the referenced block on the ledger.
   *
   * The payment payload carries the Nano block hash that the payer submitted.
   * `block_info` returns the block's destination and amount; both must match the
   * payment requirement for the payment to be valid.
   *
   * @returns true if the block exists on the ledger and pays the required recipient+amount
   */
  async verify(
    request: Payment402Request,
    response: Payment402Response,
  ): Promise<boolean> {
    // Extract the Nano block hash. For the 'exact' scheme the payer puts the
    // block hash in the payload; we also accept it in the response txHash.
    const payload = this.parsePayload(response);
    const blockHash = payload?.blockHash || payload?.transactionHash ||
      response.txHash || response.signature || '';
    if (!blockHash) return false;

    try {
      const info = await this.rpc('block_info', { hash: blockHash });
      const block = info?.contents || {};
      const validNetwork = this.matchesNetwork(request.network);
      const validAmount = this.matchesAmount(block, request.amount);
      const validRecipient = this.matchesRecipient(block, request.recipient);
      return validNetwork && validAmount && validRecipient;
    } catch (err: any) {
      console.warn(`[NanoFacilitator] Verify failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Settle a verified Nano x402 payment.
   *
   * Nano requires no extra settlement call — the on-ledger block already settled it.
   * This returns the block hash as the transaction hash.
   *
   * @returns Settlement result with the Nano block hash
   */
  async settle(
    request: Payment402Request,
    response: Payment402Response,
  ): Promise<PaymentSettlementResponse> {
    const payload = this.parsePayload(response);
    const blockHash = payload?.blockHash || payload?.transactionHash ||
      response.txHash || response.signature || '';

    if (!blockHash) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'Nano settlement failed: no block hash in the payment payload.',
        'The payer must include the submitted Nano block hash in the x402 payload.',
        false,
      );
    }

    // Confirm the block is fully confirmed on the ledger (subtype 'send').
    try {
      const info = await this.rpc('block_info', { hash: blockHash });
      const confirmed = info?.confirmed === true || !info?.error;
      if (!confirmed) {
        throw new AgentPaymentError(
          AgentPaymentErrorCode.PAYMENT_FAILED,
          'Nano settlement rejected: block not confirmed on the ledger.',
          'Wait for the block to reach a frontier and retry.',
          true,
        );
      }
      return {
        success: true,
        transactionHash: blockHash,
        network: this.getNetwork(),
        amount: request.amount,
        facilitator: 'nano:ledger',
      };
    } catch (err: any) {
      if (err instanceof AgentPaymentError) throw err;
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        `Nano settlement failed: ${err.message}`,
        'Check Nano node connectivity and the block hash.',
        true,
      );
    }
  }

  /** Supported capabilities of this adapter. */
  getCapabilities(): { assets: string[]; network: string; schemes: string[] } {
    return {
      assets: ['XNO', 'nano'],
      network: this.getNetwork(),
      schemes: ['exact', 'exact_nano', 'upto', 'upto_nano'],
    };
  }

  // --------------------------------------------------------------------------

  private parsePayload(response: Payment402Response): Record<string, any> {
    if (!response?.paymentPayload) return {};
    try {
      const parsed = JSON.parse(response.paymentPayload);
      return parsed?.payload || parsed || {};
    } catch {
      return {};
    }
  }

  private matchesNetwork(requestNetwork?: string): boolean {
    if (!requestNetwork) return true;
    return isNanoNetwork(requestNetwork);
  }

  private matchesAmount(block: any, requiredRaw: string): boolean {
    if (!block?.amount || !requiredRaw) return true;
    return String(block.amount) === String(requiredRaw);
  }

  private matchesRecipient(block: any, recipient?: string): boolean {
    if (!block?.link_as_account || !recipient) return true;
    return block.link_as_account === recipient;
  }

  private async rpc(action: 'block_info', params: Record<string, any>): Promise<any> {
    const body = { action, ...params };
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
    }
    const result = await response.json();
    if (result?.error) {
      throw new Error(result.error);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

/**
 * Verify a Nano x402 payment without instantiating the full adapter.
 */
export async function verifyNanoPayment(
  blockHash: string,
  requirements: { network: string; maxAmountRequired: string; payTo: string },
  rpcUrl?: string,
): Promise<{ isValid: boolean; error?: string }> {
  const adapter = new NanoFacilitatorAdapter({ rpcUrl, network: requirements.network });
  const req: Payment402Request = {
    amount: requirements.maxAmountRequired,
    token: 'XNO',
    recipient: requirements.payTo,
    chain: 0,
    network: requirements.network,
    scheme: 'exact',
    original: requirements as any,
  };
  try {
    const isValid = await adapter.verify(req, {
      signature: '',
      nonce: '',
      deadline: 0,
      paymentPayload: JSON.stringify({ payload: { blockHash } }),
    });
    return { isValid };
  } catch (err: any) {
    return { isValid: false, error: err.message };
  }
}

/**
 * Build Nano x402 payment requirements for a paywall.
 */
export function buildNanoPaymentRequirements(params: {
  priceXNO: string;
  recipientAddress: string;
  network?: string;
  scheme?: 'exact' | 'upto';
  description?: string;
}) {
  const network = toNanoNetwork(params.network || 'nano:mainnet');
  return {
    scheme: params.scheme || 'exact',
    network,
    maxAmountRequired: xnoToRaw(params.priceXNO),
    asset: 'XNO',
    payTo: params.recipientAddress,
    description: params.description || 'Nano x402 payment',
  };
}
