/**
 * @packageDocumentation
 * @module SettlementContract
 * @description
 * Settlement-success contract for server-side paywalls (issue #3).
 *
 * A paywall must not grant access on HTTP success alone. A settlement is only
 * treated as successful when the facilitator response body satisfies ALL of:
 *
 * 1. The body is a JSON object.
 * 2. `success === true` (strict boolean; truthy strings/numbers are rejected).
 * 3. No `errorReason` / `error` is present.
 * 4. If a `status` field is present, it is one of `settled`, `confirmed`,
 *    `success`, `succeeded`, or `completed`. Anything else (e.g. `pending`,
 *    `submitted`, `unknown`) is treated as indeterminate and rejected.
 * 5. A transaction reference is present in `transaction`, `txHash`, or
 *    `transactionHash`. For EVM networks it must be a 32-byte hex hash
 *    (`0x` + 64 hex chars). For other networks it must be a non-empty string
 *    of at least 16 characters with no whitespace.
 *
 * Anything that does not meet this contract is a failed or indeterminate
 * settlement and MUST withhold access (fail closed).
 *
 * Note: this validates the facilitator's settlement claim. It does not
 * independently confirm the transaction on-chain; use `SettlementVerifier`
 * with an `EVMSettlementStrategy` and RPC endpoints for that.
 */

/** Evidence extracted from a facilitator settlement response that met the contract. */
export interface SettlementEvidence {
  /** Transaction hash / reference reported by the facilitator */
  txHash: string;
  /** Network reported by the facilitator (if any) */
  network?: string;
  /** Payer reported by the facilitator (if any) */
  payer?: string;
}

export type SettlementValidationResult =
  | { ok: true; evidence: SettlementEvidence }
  | { ok: false; reason: string };

const SUCCESS_STATUSES = new Set(['settled', 'confirmed', 'success', 'succeeded', 'completed']);
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const GENERIC_TX_REF = /^\S{16,}$/;
const EVM_NETWORK_PREFIXES = [
  'eip155:',
  'base',
  'ethereum',
  'optimism',
  'arbitrum',
  'polygon',
  'avalanche',
  'bsc',
  'cronos',
  'monad',
];

/** Best-effort check whether a network identifier refers to an EVM chain. */
export function isEvmNetwork(network: string | undefined): boolean {
  if (!network) return false;
  const n = network.toLowerCase();
  return EVM_NETWORK_PREFIXES.some(prefix => n.startsWith(prefix));
}

/**
 * Validate a facilitator settlement response body against the settlement-success contract.
 *
 * @param body - Parsed JSON body returned by the facilitator `/settle` endpoint
 * @param network - The network the paywall expects settlement on (used to pick the tx hash format)
 */
export function validateSettlementResponse(body: unknown, network?: string): SettlementValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'settlement response is not a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (b.success !== true) {
    return { ok: false, reason: 'settlement response did not report success === true' };
  }

  if (b.errorReason || b.error) {
    return { ok: false, reason: 'settlement response reported an error' };
  }

  if (b.status !== undefined) {
    if (typeof b.status !== 'string' || !SUCCESS_STATUSES.has(b.status.toLowerCase())) {
      return { ok: false, reason: `settlement status is not final (${String(b.status)})` };
    }
  }

  const rawHash = b.transaction ?? b.txHash ?? b.transactionHash;
  if (typeof rawHash !== 'string' || rawHash.length === 0) {
    return { ok: false, reason: 'settlement response is missing a transaction hash' };
  }

  if (isEvmNetwork(network)) {
    if (!EVM_TX_HASH.test(rawHash)) {
      return { ok: false, reason: 'settlement transaction hash is not a valid EVM tx hash' };
    }
  } else if (!GENERIC_TX_REF.test(rawHash)) {
    return { ok: false, reason: 'settlement transaction reference is malformed' };
  }

  return {
    ok: true,
    evidence: {
      txHash: rawHash,
      network: typeof b.network === 'string' ? b.network : undefined,
      payer: typeof b.payer === 'string' ? b.payer : undefined,
    },
  };
}

/** Error thrown when settlement fails, times out, or is indeterminate. Access must be withheld. */
export class SettlementFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementFailedError';
  }
}
