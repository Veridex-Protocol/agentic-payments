/**
 * Behavioral Fingerprinting — MVP
 *
 * Builds a statistical profile of an agent's normal behavior and scores
 * new actions against that profile. Unlike the AnomalyDetector (which
 * operates per-transaction), this module maintains a persistent fingerprint
 * that evolves over the agent's lifetime.
 *
 * ## Tracked Dimensions
 * - Transaction frequency (actions/minute rolling window)
 * - Recipient diversity (unique recipients / total txs)
 * - Chain concentration (entropy across chains)
 * - Amount distribution (mean, stddev)
 * - Time-of-day distribution (24-bucket histogram)
 * - Inter-action latency (mean gap between txs)
 *
 * ## Scoring
 * Each dimension produces a 0-1 deviation score. The composite score is
 * a weighted average. Scores > 0.7 are considered suspicious.
 */

// ── Types ──

export interface BehaviorFingerprint {
  /** Number of observations baked into this fingerprint */
  observationCount: number;
  /** Rolling mean of USD amounts */
  amountMean: number;
  /** Rolling variance (online Welford's algorithm) */
  amountVariance: number;
  /** Unique recipients observed */
  knownRecipients: Set<string>;
  /** Chain usage counts */
  chainCounts: Map<number, number>;
  /** 24-bucket time-of-day histogram (UTC hour) */
  hourHistogram: number[];
  /** Average gap between actions in ms */
  meanInterActionMs: number;
  /** Timestamp of last observed action */
  lastActionAt: number;
}

export interface FingerprintScore {
  /** Composite deviation score 0-1 (higher = more anomalous) */
  composite: number;
  dimensions: {
    amountDeviation: number;
    recipientNovelty: number;
    chainEntropy: number;
    timingDeviation: number;
    frequencyDeviation: number;
  };
  suspicious: boolean;
  explanation: string;
}

export interface ActionObservation {
  amountUSD: number;
  recipient: string;
  chain: number;
  timestamp: number;
}

// ── Weights ──

const WEIGHTS = {
  amountDeviation: 0.30,
  recipientNovelty: 0.25,
  chainEntropy: 0.15,
  timingDeviation: 0.15,
  frequencyDeviation: 0.15,
};

const SUSPICIOUS_THRESHOLD = 0.7;
const MIN_OBSERVATIONS = 5;

// ── Implementation ──

export class BehavioralFingerprint {
  private fingerprints = new Map<string, BehaviorFingerprint>();

  /**
   * Record an observed action for a given agent/session key.
   */
  observe(keyHash: string, action: ActionObservation): void {
    let fp = this.fingerprints.get(keyHash);
    if (!fp) {
      fp = {
        observationCount: 0,
        amountMean: 0,
        amountVariance: 0,
        knownRecipients: new Set(),
        chainCounts: new Map(),
        hourHistogram: new Array(24).fill(0),
        meanInterActionMs: 0,
        lastActionAt: 0,
      };
      this.fingerprints.set(keyHash, fp);
    }

    const n = fp.observationCount + 1;

    // Welford's online algorithm for mean & variance
    const delta = action.amountUSD - fp.amountMean;
    fp.amountMean += delta / n;
    const delta2 = action.amountUSD - fp.amountMean;
    fp.amountVariance += delta * delta2;

    // Recipients
    fp.knownRecipients.add(action.recipient.toLowerCase());

    // Chains
    fp.chainCounts.set(action.chain, (fp.chainCounts.get(action.chain) ?? 0) + 1);

    // Time of day
    const hour = new Date(action.timestamp).getUTCHours();
    fp.hourHistogram[hour]++;

    // Inter-action latency
    if (fp.lastActionAt > 0) {
      const gap = action.timestamp - fp.lastActionAt;
      fp.meanInterActionMs = fp.meanInterActionMs + (gap - fp.meanInterActionMs) / n;
    }
    fp.lastActionAt = action.timestamp;

    fp.observationCount = n;
  }

  /**
   * Score a proposed action against the agent's behavioral fingerprint.
   * Returns a composite deviation score. If insufficient history, returns
   * a neutral score (0.5) with an explanation.
   */
  score(keyHash: string, action: ActionObservation): FingerprintScore {
    const fp = this.fingerprints.get(keyHash);

    if (!fp || fp.observationCount < MIN_OBSERVATIONS) {
      return {
        composite: 0.5,
        dimensions: {
          amountDeviation: 0.5,
          recipientNovelty: 0.5,
          chainEntropy: 0.5,
          timingDeviation: 0.5,
          frequencyDeviation: 0.5,
        },
        suspicious: false,
        explanation: `Insufficient history (${fp?.observationCount ?? 0}/${MIN_OBSERVATIONS} observations)`,
      };
    }

    const dims = {
      amountDeviation: this.scoreAmount(fp, action.amountUSD),
      recipientNovelty: this.scoreRecipient(fp, action.recipient),
      chainEntropy: this.scoreChain(fp, action.chain),
      timingDeviation: this.scoreTiming(fp, action.timestamp),
      frequencyDeviation: this.scoreFrequency(fp, action.timestamp),
    };

    const composite =
      WEIGHTS.amountDeviation * dims.amountDeviation +
      WEIGHTS.recipientNovelty * dims.recipientNovelty +
      WEIGHTS.chainEntropy * dims.chainEntropy +
      WEIGHTS.timingDeviation * dims.timingDeviation +
      WEIGHTS.frequencyDeviation * dims.frequencyDeviation;

    const suspicious = composite >= SUSPICIOUS_THRESHOLD;
    const explanationParts: string[] = [];
    if (dims.amountDeviation > 0.7) explanationParts.push('unusual amount');
    if (dims.recipientNovelty > 0.7) explanationParts.push('new recipient');
    if (dims.chainEntropy > 0.7) explanationParts.push('unusual chain');
    if (dims.timingDeviation > 0.7) explanationParts.push('unusual timing');
    if (dims.frequencyDeviation > 0.7) explanationParts.push('burst frequency');

    return {
      composite,
      dimensions: dims,
      suspicious,
      explanation: suspicious
        ? `Suspicious behavior: ${explanationParts.join(', ')}`
        : 'Within normal behavioral profile',
    };
  }

  /** Get raw fingerprint for persistence */
  getFingerprint(keyHash: string): BehaviorFingerprint | undefined {
    return this.fingerprints.get(keyHash);
  }

  /** Restore a fingerprint (e.g., from DB) */
  restoreFingerprint(keyHash: string, fp: BehaviorFingerprint): void {
    // Restore Set and Map from potential JSON-deserialized objects
    fp.knownRecipients = new Set(fp.knownRecipients);
    fp.chainCounts = new Map(Object.entries(fp.chainCounts as any).map(([k, v]) => [Number(k), Number(v)]));
    this.fingerprints.set(keyHash, fp);
  }

  // ── Dimension Scorers (0 = normal, 1 = maximally deviant) ──

  private scoreAmount(fp: BehaviorFingerprint, amountUSD: number): number {
    const n = fp.observationCount;
    if (n < 2) return 0.5;
    const stddev = Math.sqrt(fp.amountVariance / (n - 1));
    if (stddev === 0) return amountUSD === fp.amountMean ? 0 : 1;
    const zScore = Math.abs(amountUSD - fp.amountMean) / stddev;
    return Math.min(zScore / 4, 1); // Normalize: z=4 → score=1
  }

  private scoreRecipient(fp: BehaviorFingerprint, recipient: string): number {
    return fp.knownRecipients.has(recipient.toLowerCase()) ? 0 : 0.8;
  }

  private scoreChain(fp: BehaviorFingerprint, chain: number): number {
    const total = fp.observationCount;
    const chainCount = fp.chainCounts.get(chain) ?? 0;
    if (chainCount === 0) return 0.9; // Never-seen chain
    return 1 - (chainCount / total); // Rare chain → higher score
  }

  private scoreTiming(fp: BehaviorFingerprint, timestamp: number): number {
    const hour = new Date(timestamp).getUTCHours();
    const total = fp.hourHistogram.reduce((a, b) => a + b, 0);
    if (total === 0) return 0.5;
    const hourFreq = fp.hourHistogram[hour] / total;
    // If this hour has 0% of past traffic, high deviation
    if (hourFreq === 0) return 0.85;
    // Normalize against uniform distribution (1/24 ≈ 0.042)
    return Math.max(0, 1 - hourFreq * 24);
  }

  private scoreFrequency(fp: BehaviorFingerprint, timestamp: number): number {
    if (fp.lastActionAt === 0 || fp.meanInterActionMs === 0) return 0.5;
    const gap = timestamp - fp.lastActionAt;
    if (gap <= 0) return 0.9; // Simultaneous action
    const ratio = fp.meanInterActionMs / gap;
    // ratio > 1 means this action is faster than average
    if (ratio > 10) return 0.95; // 10x faster than average
    if (ratio > 5) return 0.7;
    if (ratio > 2) return 0.4;
    return 0.1;
  }
}
