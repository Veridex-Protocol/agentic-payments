/**
 * @packageDocumentation
 * @module PaymentIntent
 * @description
 * Universal payment intent normalization layer.
 *
 * PaymentIntent is the protocol-agnostic representation of a payment request.
 * Every protocol handler converts its native payment challenge into a PaymentIntent
 * before policy evaluation, ensuring the PolicyEngine never needs to know
 * which protocol is being used.
 *
 * Flow: Protocol Challenge → PaymentIntent → ProposedAction → PolicyEngine
 */

import type { CostEstimate, ProtocolName, PaymentSettlement } from './types';
import type { ProposedAction, ActionType } from '../../policy/types';

/** Payment scheme — how the payment is structured */
export type PaymentScheme =
  | 'exact'        // Fixed amount, one-time
  | 'upto'         // Maximum amount, actual may be less
  | 'subscription' // Recurring payment
  | 'streaming'    // Pay-as-you-go / metered
  | 'escrow'       // Held until conditions met
  | 'prepaid';     // Pre-funded session

/** Payment intent status */
export type IntentStatus =
  | 'pending'      // Created, not yet evaluated
  | 'approved'     // Policy approved
  | 'rejected'     // Policy blocked
  | 'settled'      // Payment completed
  | 'failed'       // Payment attempted but failed
  | 'expired';     // TTL exceeded

/**
 * Universal payment intent — the canonical form every protocol converts to.
 */
export interface PaymentIntent {
  /** Unique intent identifier */
  readonly id: string;

  /** Protocol that originated this intent */
  readonly protocol: ProtocolName;

  /** Payment scheme */
  readonly scheme: PaymentScheme;

  /** Recipient address, URL, or endpoint */
  readonly recipient: string;

  /** Token symbol or address */
  readonly asset: string;

  /** Amount in token's smallest unit */
  readonly amount: string;

  /** Estimated USD value */
  readonly amountUSD: number;

  /** Chain identifier (Wormhole chain ID) */
  readonly chain: number;

  /** Resource being paid for (URL, API endpoint, content ID) */
  readonly resource: string;

  /** When this intent was created */
  readonly createdAt: number;

  /** TTL in ms — intent expires after this */
  readonly ttlMs: number;

  /** Current status */
  status: IntentStatus;

  /** Protocol-specific challenge data (opaque to policy engine) */
  readonly challengeData?: Record<string, unknown>;

  /** Human-readable description of what's being paid for */
  readonly description?: string;
}

/**
 * Create a PaymentIntent from a CostEstimate and request context.
 */
export function createPaymentIntent(
  protocol: ProtocolName,
  estimate: CostEstimate,
  resource: string,
  options?: {
    recipient?: string;
    ttlMs?: number;
    challengeData?: Record<string, unknown>;
    description?: string;
  },
): PaymentIntent {
  return {
    id: generateIntentId(),
    protocol,
    scheme: normalizeScheme(estimate.scheme),
    recipient: options?.recipient ?? resource,
    asset: estimate.token,
    amount: estimate.amountRaw,
    amountUSD: estimate.amountUSD,
    chain: typeof estimate.chain === 'number' ? estimate.chain : 0,
    resource,
    createdAt: Date.now(),
    ttlMs: options?.ttlMs ?? 300_000, // 5 minutes default
    status: 'pending',
    challengeData: options?.challengeData,
    description: options?.description ?? estimate.description,
  };
}

/**
 * Convert a PaymentIntent into a ProposedAction for policy evaluation.
 */
export function intentToProposedAction(
  intent: PaymentIntent,
  actionType: ActionType = 'payment',
): ProposedAction {
  return {
    type: actionType,
    recipient: intent.recipient,
    asset: intent.asset,
    amount: intent.amount,
    amountUSD: intent.amountUSD,
    chain: intent.chain,
    protocol: intent.protocol,
    metadata: {
      intentId: intent.id,
      resource: intent.resource,
      scheme: intent.scheme,
      ...(intent.challengeData ?? {}),
    },
  };
}

/**
 * Check if a PaymentIntent has expired.
 */
export function isIntentExpired(intent: PaymentIntent): boolean {
  return Date.now() > intent.createdAt + intent.ttlMs;
}

/**
 * Mark intent as settled with settlement data.
 */
export function settleIntent(
  intent: PaymentIntent,
  settlement: PaymentSettlement,
): PaymentIntent {
  return {
    ...intent,
    status: settlement.success ? 'settled' : 'failed',
  };
}

// ── Internal helpers ──

function generateIntentId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `pi_${timestamp}_${random}`;
}

function normalizeScheme(scheme: string): PaymentScheme {
  const normalized = scheme.toLowerCase().trim();
  const schemeMap: Record<string, PaymentScheme> = {
    exact: 'exact',
    upto: 'upto',
    'up-to': 'upto',
    subscription: 'subscription',
    recurring: 'subscription',
    streaming: 'streaming',
    metered: 'streaming',
    'pay-as-you-go': 'streaming',
    escrow: 'escrow',
    prepaid: 'prepaid',
    session: 'prepaid',
  };
  return schemeMap[normalized] ?? 'exact';
}
