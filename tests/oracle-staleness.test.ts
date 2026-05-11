/**
 * Oracle staleness hard-revert tests (VDX-SEC-2026-04 task 2).
 *
 * Validates that `getPriceStrict` and `checkLimitsStrict` refuse to authorize
 * spending against stale, low-confidence, or missing quotes. The legacy
 * `getPrice` / `checkLimits` surface is intentionally unchanged.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpendingTracker } from '../src/session/SpendingTracker';
import {
  assertQuoteFresh,
  LowConfidenceError,
  OracleError,
  PriceQuote,
  StalePriceError,
} from '../src/oracle/StalePriceError';
import { PythOracle } from '../src/oracle/PythOracle';
import type { StoredSession } from '../src/session/SessionStorage';

function makeQuote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  const now = Math.floor(Date.now() / 1000);
  return {
    feedId: 'ETH',
    price: 3000,
    confidence: 3,
    publishTime: now,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  const now = Date.now();
  return {
    id: 'sess-1',
    config: {
      dailyLimitUSD: 100,
      perTransactionLimitUSD: 50,
      expiryHours: 24,
    } as any,
    metadata: {
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      lastUsedAt: now,
      dailySpentUSD: 0,
      dailySpentCents: 0,
      totalSpentUSD: 0,
      dailyResetAt: now + 24 * 60 * 60 * 1000,
      transactionCount: 0,
    } as any,
    ...overrides,
  } as StoredSession;
}

describe('assertQuoteFresh', () => {
  it('accepts a fresh quote', () => {
    const q = makeQuote();
    expect(() => assertQuoteFresh(q, 60)).not.toThrow();
  });

  it('throws StalePriceError for an aged quote', () => {
    const q = makeQuote({ publishTime: Math.floor(Date.now() / 1000) - 120 });
    expect(() => assertQuoteFresh(q, 60)).toThrow(StalePriceError);
  });

  it('includes ageSeconds and maxStaleSeconds on the error', () => {
    const q = makeQuote({ publishTime: Math.floor(Date.now() / 1000) - 300 });
    try {
      assertQuoteFresh(q, 30);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StalePriceError);
      expect((err as StalePriceError).maxStaleSeconds).toBe(30);
      expect((err as StalePriceError).ageSeconds).toBeGreaterThan(30);
    }
  });
});

describe('SpendingTracker.checkLimitsStrict', () => {
  let tracker: SpendingTracker;
  beforeEach(() => {
    tracker = new SpendingTracker();
  });

  it('authorizes a fresh quote within limits', () => {
    const session = makeSession();
    const quote = makeQuote({ price: 3000 });
    const result = tracker.checkLimitsStrict(session, {
      quote,
      nativeAmount: 0.01, // 0.01 * 3000 = $30
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks when per-tx cap would be breached', () => {
    const session = makeSession();
    const quote = makeQuote({ price: 3000 });
    const result = tracker.checkLimitsStrict(session, {
      quote,
      nativeAmount: 0.05, // $150 > $50 per-tx
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/per-transaction/);
  });

  it('HARD REVERTS on a stale quote rather than authorizing', () => {
    const session = makeSession();
    const quote = makeQuote({
      price: 3000,
      publishTime: Math.floor(Date.now() / 1000) - 500,
    });
    expect(() =>
      tracker.checkLimitsStrict(session, { quote, nativeAmount: 0.001 }),
    ).toThrow(StalePriceError);
  });

  it('rejects zero-priced quote even if tracker is fresh', () => {
    const session = makeSession();
    const quote = makeQuote({ price: 0 });
    const result = tracker.checkLimitsStrict(session, { quote, nativeAmount: 1e9 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Invalid price/);
  });

  it('rejects negative or NaN nativeAmount', () => {
    const session = makeSession();
    const quote = makeQuote();
    expect(
      tracker.checkLimitsStrict(session, { quote, nativeAmount: -1 }).allowed,
    ).toBe(false);
    expect(
      tracker.checkLimitsStrict(session, { quote, nativeAmount: NaN }).allowed,
    ).toBe(false);
  });

  it('uses caller-supplied maxStaleSeconds when tighter than default', () => {
    const session = makeSession();
    const quote = makeQuote({
      publishTime: Math.floor(Date.now() / 1000) - 10,
    });
    // Default 60s would allow; caller wants 5s max.
    expect(() =>
      tracker.checkLimitsStrict(session, {
        quote,
        nativeAmount: 0.001,
        maxStaleSeconds: 5,
      }),
    ).toThrow(StalePriceError);
  });
});

describe('PythOracle.getPriceStrict', () => {
  // We avoid hitting the live Hermes endpoint. Instead we inject a mock via
  // axios stubbing. Tests here focus on the validation logic, not transport.

  it('throws StalePriceError when Hermes returns an old publish_time', async () => {
    const oracle = PythOracle.getInstance();
    const axios = (await import('axios')).default;
    const stalePublishTime = Math.floor(Date.now() / 1000) - 600;
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        parsed: [
          {
            id: 'eth',
            price: {
              price: '300000000000',
              conf: '100000000',
              expo: -8,
              publish_time: stalePublishTime,
            },
            ema_price: {} as any,
          },
        ],
      },
    } as any);

    await expect(
      oracle.getPriceStrict('ETH', { maxStaleSeconds: 60, forceFresh: true }),
    ).rejects.toBeInstanceOf(StalePriceError);

    spy.mockRestore();
  });

  it('throws LowConfidenceError when conf/price exceeds ratio', async () => {
    const oracle = PythOracle.getInstance();
    const axios = (await import('axios')).default;
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        parsed: [
          {
            id: 'eth',
            price: {
              // price=3000, conf=300  -> ratio=0.1 (way over 0.02 default)
              price: '300000000000',
              conf: '30000000000',
              expo: -8,
              publish_time: Math.floor(Date.now() / 1000),
            },
            ema_price: {} as any,
          },
        ],
      },
    } as any);

    await expect(
      oracle.getPriceStrict('ETH', { forceFresh: true }),
    ).rejects.toBeInstanceOf(LowConfidenceError);

    spy.mockRestore();
  });

  it('throws OracleError on empty Hermes response', async () => {
    const oracle = PythOracle.getInstance();
    const axios = (await import('axios')).default;
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: { parsed: [] },
    } as any);

    await expect(
      oracle.getPriceStrict('ETH', { forceFresh: true }),
    ).rejects.toBeInstanceOf(OracleError);

    spy.mockRestore();
  });

  it('returns a valid PriceQuote on a fresh, high-confidence response', async () => {
    const oracle = PythOracle.getInstance();
    const axios = (await import('axios')).default;
    const now = Math.floor(Date.now() / 1000);
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        parsed: [
          {
            id: 'eth',
            price: {
              price: '300000000000', // 3000
              conf: '100000000', // 1.0 -> ratio 0.00033
              expo: -8,
              publish_time: now,
            },
            ema_price: {} as any,
          },
        ],
      },
    } as any);

    const quote = await oracle.getPriceStrict('ETH', { forceFresh: true });
    expect(quote.price).toBeCloseTo(3000, 2);
    expect(quote.publishTime).toBe(now);
    expect(quote.confidence).toBeCloseTo(1.0, 2);

    spy.mockRestore();
  });
});
