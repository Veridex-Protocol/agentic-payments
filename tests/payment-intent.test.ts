/**
 * Tests for PaymentIntent normalization (Phase 4.1)
 */
import { describe, it, expect } from 'vitest';
import {
  createPaymentIntent,
  intentToProposedAction,
  isIntentExpired,
  settleIntent,
} from '../src/protocols/base/PaymentIntent';
import type { CostEstimate, PaymentSettlement } from '../src/protocols/base/types';

function createMockEstimate(overrides?: Partial<CostEstimate>): CostEstimate {
  return {
    amountUSD: 5.0,
    amountRaw: '5000000',
    token: 'USDC',
    chain: 2,
    scheme: 'exact',
    confidence: 0.99,
    description: 'Test payment',
    ...overrides,
  };
}

describe('PaymentIntent', () => {
  describe('createPaymentIntent', () => {
    it('should create an intent from a CostEstimate', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('x402', estimate, 'https://api.example.com/resource');

      expect(intent.id).toMatch(/^pi_/);
      expect(intent.protocol).toBe('x402');
      expect(intent.scheme).toBe('exact');
      expect(intent.asset).toBe('USDC');
      expect(intent.amount).toBe('5000000');
      expect(intent.amountUSD).toBe(5.0);
      expect(intent.chain).toBe(2);
      expect(intent.resource).toBe('https://api.example.com/resource');
      expect(intent.status).toBe('pending');
      expect(intent.ttlMs).toBe(300_000);
    });

    it('should use recipient from options when provided', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('ucp', estimate, 'https://example.com', {
        recipient: '0xRecipient',
      });
      expect(intent.recipient).toBe('0xRecipient');
    });

    it('should fall back to resource as recipient', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('ucp', estimate, 'https://example.com');
      expect(intent.recipient).toBe('https://example.com');
    });

    it('should pass through challengeData', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('mpp', estimate, 'https://example.com', {
        challengeData: { requestId: 'req-123', method: 'tempo' },
      });
      expect(intent.challengeData?.requestId).toBe('req-123');
    });

    it('should normalize string chain to 0', () => {
      const estimate = createMockEstimate({ chain: 'base-mainnet' as any });
      const intent = createPaymentIntent('x402', estimate, 'https://example.com');
      expect(intent.chain).toBe(0);
    });

    it('should normalize scheme variants', () => {
      const tests: [string, string][] = [
        ['exact', 'exact'],
        ['upto', 'upto'],
        ['up-to', 'upto'],
        ['subscription', 'subscription'],
        ['recurring', 'subscription'],
        ['streaming', 'streaming'],
        ['metered', 'streaming'],
        ['pay-as-you-go', 'streaming'],
        ['escrow', 'escrow'],
        ['prepaid', 'prepaid'],
        ['session', 'prepaid'],
        ['unknown', 'exact'], // fallback
      ];

      for (const [input, expected] of tests) {
        const estimate = createMockEstimate({ scheme: input });
        const intent = createPaymentIntent('x402', estimate, 'https://example.com');
        expect(intent.scheme).toBe(expected);
      }
    });

    it('should accept custom TTL', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('x402', estimate, 'https://example.com', {
        ttlMs: 60_000,
      });
      expect(intent.ttlMs).toBe(60_000);
    });
  });

  describe('intentToProposedAction', () => {
    it('should convert intent to ProposedAction', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('x402', estimate, 'https://example.com', {
        recipient: '0xMerchant',
      });
      const action = intentToProposedAction(intent);

      expect(action.type).toBe('payment');
      expect(action.recipient).toBe('0xMerchant');
      expect(action.asset).toBe('USDC');
      expect(action.amount).toBe('5000000');
      expect(action.amountUSD).toBe(5.0);
      expect(action.chain).toBe(2);
      expect(action.protocol).toBe('x402');
      expect(action.metadata?.intentId).toBe(intent.id);
      expect(action.metadata?.resource).toBe('https://example.com');
      expect(action.metadata?.scheme).toBe('exact');
    });

    it('should support custom action type', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('ucp', estimate, 'https://example.com');
      const action = intentToProposedAction(intent, 'swap');
      expect(action.type).toBe('swap');
    });
  });

  describe('isIntentExpired', () => {
    it('should return false for fresh intent', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('x402', estimate, 'https://example.com');
      expect(isIntentExpired(intent)).toBe(false);
    });

    it('should return true for expired intent', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('x402', estimate, 'https://example.com', {
        ttlMs: 1,
      });
      // Force expiration
      const expired = { ...intent, createdAt: Date.now() - 1000 };
      expect(isIntentExpired(expired)).toBe(true);
    });
  });

  describe('settleIntent', () => {
    it('should mark intent as settled on success', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('x402', estimate, 'https://example.com');

      const settlement: PaymentSettlement = {
        success: true,
        protocol: 'x402',
        network: 'base',
        amount: '5000000',
        token: 'USDC',
        settledAt: Date.now(),
      };

      const settled = settleIntent(intent, settlement);
      expect(settled.status).toBe('settled');
    });

    it('should mark intent as failed on failure', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('x402', estimate, 'https://example.com');

      const settlement: PaymentSettlement = {
        success: false,
        protocol: 'x402',
        network: 'base',
        amount: '0',
        token: 'USDC',
        settledAt: Date.now(),
        error: 'Insufficient balance',
      };

      const failed = settleIntent(intent, settlement);
      expect(failed.status).toBe('failed');
    });

    it('should preserve all other fields', () => {
      const estimate = createMockEstimate();
      const intent = createPaymentIntent('x402', estimate, 'https://example.com');

      const settlement: PaymentSettlement = {
        success: true,
        protocol: 'x402',
        network: 'base',
        amount: '5000000',
        token: 'USDC',
        settledAt: Date.now(),
      };

      const settled = settleIntent(intent, settlement);
      expect(settled.id).toBe(intent.id);
      expect(settled.protocol).toBe(intent.protocol);
      expect(settled.amount).toBe(intent.amount);
    });
  });
});
