/**
 * @module oracle/StalePriceError
 * @description
 * Typed errors for oracle freshness and quality guards.
 *
 * The legacy `PythOracle.getPrice()` returns `0` on failure and many callers
 * silently substitute hardcoded fallbacks ($0.50 STX, $60000 BTC, $1.0 for
 * unknown tokens). That is a cap-bypass footgun: if `getPrice` returns 0 and
 * the caller does `amountUSD = qty * price`, the tracker sees $0 and authorizes
 * any transfer. Likewise, a stale quote during a crash allows spending at the
 * last-known-good price even when the market moved 10x.
 *
 * The strict path (`getPriceStrict` → `PriceQuote` → `checkLimitsStrict`)
 * refuses to produce a number in those cases; it throws. Callers explicitly
 * choose whether to hard-fail the payment or use a feature-flagged fallback.
 */

export type OracleErrorCode =
  | 'ORACLE_UNAVAILABLE'
  | 'ORACLE_STALE'
  | 'ORACLE_LOW_CONFIDENCE'
  | 'ORACLE_UNKNOWN_FEED'
  | 'ORACLE_UNKNOWN_TOKEN';

/** Default freshness bound. Short enough to catch oracle-outage windows. */
export const DEFAULT_MAX_STALE_SECONDS = 60;
/** Default max conf/price ratio. Pyth recommends <= 0.01 for price-critical paths. */
export const DEFAULT_MAX_CONFIDENCE_RATIO = 0.02;

export class OracleError extends Error {
  constructor(
    public readonly code: OracleErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OracleError';
  }
}

export class StalePriceError extends OracleError {
  constructor(
    public readonly feedId: string,
    public readonly publishTime: number,
    public readonly ageSeconds: number,
    public readonly maxStaleSeconds: number,
  ) {
    super(
      'ORACLE_STALE',
      `Price for ${feedId} is ${ageSeconds.toFixed(1)}s old (max ${maxStaleSeconds}s). ` +
        `publishTime=${new Date(publishTime * 1000).toISOString()}. ` +
        `Refusing to authorize spend against a stale quote.`,
      { feedId, publishTime, ageSeconds, maxStaleSeconds },
    );
    this.name = 'StalePriceError';
  }
}

export class LowConfidenceError extends OracleError {
  constructor(
    public readonly feedId: string,
    public readonly price: number,
    public readonly confidence: number,
    public readonly ratio: number,
    public readonly maxRatio: number,
  ) {
    super(
      'ORACLE_LOW_CONFIDENCE',
      `Price for ${feedId} has confidence ${confidence} on price ${price} (ratio=${ratio.toFixed(4)}, ` +
        `max ${maxRatio}). Refusing to authorize spend against a low-confidence quote.`,
      { feedId, price, confidence, ratio, maxRatio },
    );
    this.name = 'LowConfidenceError';
  }
}

/**
 * A fresh, validated price quote. Callers MUST treat the `publishTime` as
 * authoritative; the oracle layer has already validated it against the
 * configured `maxStaleSeconds` at fetch time, but consumers that cache this
 * quote should re-validate before using it far from the fetch site.
 */
export interface PriceQuote {
  /** Pyth feed id (hex) or resolved symbol. */
  feedId: string;
  /** USD price. */
  price: number;
  /** Pyth confidence interval (absolute, same units as price). */
  confidence: number;
  /** Unix seconds at which the aggregated price was published on Pyth. */
  publishTime: number;
  /** Unix ms when this quote was fetched locally. */
  fetchedAt: number;
}

export interface PriceQuoteOptions {
  /** Hard cap on publish-time age, seconds. Default 60. */
  maxStaleSeconds?: number;
  /**
   * Max allowed conf/price ratio. Pyth recommends <= 0.01 for price-sensitive
   * use. Default 0.02 to avoid over-tripping on volatile assets.
   */
  maxConfidenceRatio?: number;
  /** Skip cache lookup; always fetch fresh. Default false. */
  forceFresh?: boolean;
}

/**
 * Revalidate a previously-fetched quote against a freshness bound.
 * Use this at the moment you charge against the quote, not at the moment
 * you computed it.
 */
export function assertQuoteFresh(
  quote: PriceQuote,
  maxStaleSeconds: number,
  now: number = Date.now(),
): void {
  const ageSeconds = (now - quote.publishTime * 1000) / 1000;
  if (ageSeconds > maxStaleSeconds) {
    throw new StalePriceError(quote.feedId, quote.publishTime, ageSeconds, maxStaleSeconds);
  }
}
