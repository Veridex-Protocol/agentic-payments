/**
 * @packageDocumentation
 * @module AnomalyDetector
 * @description
 * Unified anomaly detection with behavioral fingerprinting.
 *
 * Two modes of operation:
 * 1. **Batch analysis** (`analyze` / `evaluate`) — compares a proposed action
 *    against a supplied history array. Stateless per call.
 * 2. **Streaming fingerprint** (`observe` / `score`) — maintains an online
 *    behavioral profile per session key using Welford's algorithm. Stateful,
 *    evolves over the agent's lifetime. Catches drift that batch can't.
 *
 * Anomaly types (shared by both modes):
 * - new_recipient
 * - unusual_amount
 * - new_chain
 * - unusual_time
 * - unusual_frequency
 *
 * Implements PolicyRule for Policy Engine integration.
 */

import type {
  PolicyRule,
  PolicyCheck,
  EvaluationContext,
  RuleSeverity,
  TransactionHistoryEntry,
} from '../policy/types';

// ── Types ──

export interface AnomalyConfig {
  /** Lookback window for baseline computation (ms). Default: 7 days. */
  baselineWindowMs: number;
  /** Standard deviations above mean to flag as anomalous. Default: 2.5 */
  amountStdDevThreshold: number;
  /** Minimum history entries needed to compute baseline. Default: 5 */
  minHistoryForBaseline: number;
  /** Composite fingerprint score threshold for suspicious flag (0-1). Default: 0.7 */
  suspiciousThreshold: number;
}

export interface AnomalyResult {
  detected: boolean;
  anomalies: AnomalyDetail[];
  riskScore: number;
}

export interface AnomalyDetail {
  type: AnomalyType;
  description: string;
  severity: 'high' | 'medium' | 'low';
}

export type AnomalyType =
  | 'new_recipient'
  | 'unusual_amount'
  | 'new_chain'
  | 'unusual_time'
  | 'unusual_frequency';

// ── Fingerprint types ──

export interface BehaviorFingerprint {
  observationCount: number;
  amountMean: number;
  /** Welford's running sum of squared differences (divide by n-1 for variance) */
  amountM2: number;
  knownRecipients: Set<string>;
  chainCounts: Map<number, number>;
  /** 24-bucket time-of-day histogram (UTC) */
  hourHistogram: number[];
  /** Running mean of inter-action gap in ms */
  meanInterActionMs: number;
  lastActionAt: number;
}

export interface FingerprintScore {
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

// ── Constants ──

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG: AnomalyConfig = {
  baselineWindowMs: 7 * ONE_DAY_MS,
  amountStdDevThreshold: 2.5,
  minHistoryForBaseline: 5,
  suspiciousThreshold: 0.7,
};

const FINGERPRINT_WEIGHTS = {
  amountDeviation: 0.30,
  recipientNovelty: 0.25,
  chainEntropy: 0.15,
  timingDeviation: 0.15,
  frequencyDeviation: 0.15,
} as const;

const MIN_FINGERPRINT_OBSERVATIONS = 5;

// ── Implementation ──

export class AnomalyDetector implements PolicyRule {
  readonly id = 'anomaly-detector';
  readonly name = 'Anomaly Detector';
  readonly severity: RuleSeverity = 'medium';
  enabled = true;

  private config: AnomalyConfig;

  /** Streaming behavioral fingerprints keyed by session key hash */
  private fingerprints = new Map<string, BehaviorFingerprint>();

  constructor(config?: Partial<AnomalyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ====================================================================
  //  Mode 1: Batch analysis (stateless, against history array)
  // ====================================================================

  /**
   * Analyze a proposed action against historical baseline.
   */
  analyze(
    action: { recipient: string; amountUSD: number; chain: number },
    history: TransactionHistoryEntry[],
    timestamp: number
  ): AnomalyResult {
    const anomalies: AnomalyDetail[] = [];
    const cutoff = timestamp - this.config.baselineWindowMs;
    const recent = history.filter((h) => h.timestamp >= cutoff);

    if (recent.length < this.config.minHistoryForBaseline) {
      return { detected: false, anomalies: [], riskScore: 0 };
    }

    // 1. New recipient
    const knownRecipients = new Set(recent.map((h) => h.recipient.toLowerCase()));
    if (!knownRecipients.has(action.recipient.toLowerCase())) {
      anomalies.push({
        type: 'new_recipient',
        description: `Recipient "${action.recipient}" has not been seen in the last ${this.formatMs(this.config.baselineWindowMs)}`,
        severity: 'medium',
      });
    }

    // 2. Unusual amount (z-score)
    const amounts = recent.map((h) => h.amountUSD);
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const variance = amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev > 0 && action.amountUSD > mean + this.config.amountStdDevThreshold * stdDev) {
      anomalies.push({
        type: 'unusual_amount',
        description: `Amount $${action.amountUSD.toFixed(2)} is ${((action.amountUSD - mean) / stdDev).toFixed(1)} std devs above mean $${mean.toFixed(2)}`,
        severity: 'high',
      });
    }

    // 3. New chain
    const knownChains = new Set(recent.map((h) => h.chain));
    if (!knownChains.has(action.chain)) {
      anomalies.push({
        type: 'new_chain',
        description: `Chain ${action.chain} has not been used in the last ${this.formatMs(this.config.baselineWindowMs)}`,
        severity: 'medium',
      });
    }

    // 4. Unusual time-of-day
    const hours = recent.map((h) => new Date(h.timestamp).getUTCHours());
    const currentHour = new Date(timestamp).getUTCHours();
    const hourFrequency = new Map<number, number>();
    for (const h of hours) {
      hourFrequency.set(h, (hourFrequency.get(h) ?? 0) + 1);
    }
    const currentHourFreq = hourFrequency.get(currentHour) ?? 0;
    const avgHourFreq = recent.length / 24;
    if (currentHourFreq < avgHourFreq * 0.1 && recent.length >= 10) {
      anomalies.push({
        type: 'unusual_time',
        description: `Transaction at hour ${currentHour} UTC is unusual based on historical patterns`,
        severity: 'low',
      });
    }

    const riskScore = this.computeRisk(anomalies);
    return { detected: anomalies.length > 0, anomalies, riskScore };
  }

  /**
   * PolicyRule implementation — batch mode.
   */
  async evaluate(ctx: EvaluationContext): Promise<PolicyCheck> {
    const { action, history = [], timestamp } = ctx;

    const result = this.analyze(
      { recipient: action.recipient, amountUSD: action.amountUSD, chain: action.chain },
      history,
      timestamp
    );

    if (!result.detected) {
      return {
        ruleId: this.id,
        ruleName: this.name,
        passed: true,
        verdict: 'pass',
        reason: 'No anomalies detected',
        riskContribution: 0,
      };
    }

    const hasHigh = result.anomalies.some((a) => a.severity === 'high');

    return {
      ruleId: this.id,
      ruleName: this.name,
      passed: false,
      verdict: hasHigh ? 'escalate' : 'flag',
      reason: result.anomalies.map((a) => a.description).join('; '),
      riskContribution: result.riskScore,
      metadata: { anomalies: result.anomalies },
    };
  }

  // ====================================================================
  //  Mode 2: Streaming fingerprint (stateful, Welford's algorithm)
  // ====================================================================

  /**
   * Record an observed action and update the behavioral fingerprint
   * for the given session key.
   */
  observe(keyHash: string, action: ActionObservation): void {
    let fp = this.fingerprints.get(keyHash);
    if (!fp) {
      fp = {
        observationCount: 0,
        amountMean: 0,
        amountM2: 0,
        knownRecipients: new Set(),
        chainCounts: new Map(),
        hourHistogram: new Array(24).fill(0),
        meanInterActionMs: 0,
        lastActionAt: 0,
      };
      this.fingerprints.set(keyHash, fp);
    }

    const n = fp.observationCount + 1;

    // Welford's online mean & M2
    const delta = action.amountUSD - fp.amountMean;
    fp.amountMean += delta / n;
    const delta2 = action.amountUSD - fp.amountMean;
    fp.amountM2 += delta * delta2;

    fp.knownRecipients.add(action.recipient.toLowerCase());
    fp.chainCounts.set(action.chain, (fp.chainCounts.get(action.chain) ?? 0) + 1);

    const hour = new Date(action.timestamp).getUTCHours();
    fp.hourHistogram[hour]++;

    if (fp.lastActionAt > 0) {
      const gap = action.timestamp - fp.lastActionAt;
      fp.meanInterActionMs += (gap - fp.meanInterActionMs) / n;
    }
    fp.lastActionAt = action.timestamp;

    fp.observationCount = n;
  }

  /**
   * Score a proposed action against the streaming behavioral fingerprint.
   * Returns composite deviation score (0–1). Insufficient history → neutral 0.5.
   */
  score(keyHash: string, action: ActionObservation): FingerprintScore {
    const fp = this.fingerprints.get(keyHash);

    if (!fp || fp.observationCount < MIN_FINGERPRINT_OBSERVATIONS) {
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
        explanation: `Insufficient history (${fp?.observationCount ?? 0}/${MIN_FINGERPRINT_OBSERVATIONS} observations)`,
      };
    }

    const dims = {
      amountDeviation: this.fpScoreAmount(fp, action.amountUSD),
      recipientNovelty: this.fpScoreRecipient(fp, action.recipient),
      chainEntropy: this.fpScoreChain(fp, action.chain),
      timingDeviation: this.fpScoreTiming(fp, action.timestamp),
      frequencyDeviation: this.fpScoreFrequency(fp, action.timestamp),
    };

    const composite =
      FINGERPRINT_WEIGHTS.amountDeviation * dims.amountDeviation +
      FINGERPRINT_WEIGHTS.recipientNovelty * dims.recipientNovelty +
      FINGERPRINT_WEIGHTS.chainEntropy * dims.chainEntropy +
      FINGERPRINT_WEIGHTS.timingDeviation * dims.timingDeviation +
      FINGERPRINT_WEIGHTS.frequencyDeviation * dims.frequencyDeviation;

    const suspicious = composite >= this.config.suspiciousThreshold;
    const flags: string[] = [];
    if (dims.amountDeviation > 0.7) flags.push('unusual amount');
    if (dims.recipientNovelty > 0.7) flags.push('new recipient');
    if (dims.chainEntropy > 0.7) flags.push('unusual chain');
    if (dims.timingDeviation > 0.7) flags.push('unusual timing');
    if (dims.frequencyDeviation > 0.7) flags.push('burst frequency');

    return {
      composite,
      dimensions: dims,
      suspicious,
      explanation: suspicious
        ? `Suspicious behavior: ${flags.join(', ')}`
        : 'Within normal behavioral profile',
    };
  }

  /** Get raw fingerprint for persistence / export */
  getFingerprint(keyHash: string): BehaviorFingerprint | undefined {
    return this.fingerprints.get(keyHash);
  }

  /** Restore a fingerprint (e.g., from DB) */
  restoreFingerprint(keyHash: string, fp: BehaviorFingerprint): void {
    fp.knownRecipients = new Set(fp.knownRecipients);
    fp.chainCounts = new Map(
      Object.entries(fp.chainCounts as unknown as Record<string, number>).map(([k, v]) => [Number(k), v])
    );
    this.fingerprints.set(keyHash, fp);
  }

  // ── Fingerprint dimension scorers (0 = normal, 1 = maximally deviant) ──

  private fpScoreAmount(fp: BehaviorFingerprint, amountUSD: number): number {
    if (fp.observationCount < 2) return 0.5;
    const variance = fp.amountM2 / (fp.observationCount - 1);
    const stddev = Math.sqrt(variance);
    if (stddev === 0) return amountUSD === fp.amountMean ? 0 : 1;
    const zScore = Math.abs(amountUSD - fp.amountMean) / stddev;
    return Math.min(zScore / 4, 1);
  }

  private fpScoreRecipient(fp: BehaviorFingerprint, recipient: string): number {
    return fp.knownRecipients.has(recipient.toLowerCase()) ? 0 : 0.8;
  }

  private fpScoreChain(fp: BehaviorFingerprint, chain: number): number {
    const chainCount = fp.chainCounts.get(chain) ?? 0;
    if (chainCount === 0) return 0.9;
    return 1 - chainCount / fp.observationCount;
  }

  private fpScoreTiming(fp: BehaviorFingerprint, timestamp: number): number {
    const hour = new Date(timestamp).getUTCHours();
    const total = fp.hourHistogram.reduce((a, b) => a + b, 0);
    if (total === 0) return 0.5;
    const hourFreq = fp.hourHistogram[hour] / total;
    if (hourFreq === 0) return 0.85;
    return Math.max(0, 1 - hourFreq * 24);
  }

  private fpScoreFrequency(fp: BehaviorFingerprint, timestamp: number): number {
    if (fp.lastActionAt === 0 || fp.meanInterActionMs === 0) return 0.5;
    const gap = timestamp - fp.lastActionAt;
    if (gap <= 0) return 0.9;
    const ratio = fp.meanInterActionMs / gap;
    if (ratio > 10) return 0.95;
    if (ratio > 5) return 0.7;
    if (ratio > 2) return 0.4;
    return 0.1;
  }

  // ── Shared helpers ──

  private computeRisk(anomalies: AnomalyDetail[]): number {
    const weights: Record<string, number> = { high: 20, medium: 10, low: 5 };
    return Math.min(
      100,
      anomalies.reduce((sum, a) => sum + (weights[a.severity] ?? 5), 0)
    );
  }

  private formatMs(ms: number): string {
    const days = Math.round(ms / ONE_DAY_MS);
    return `${days} day${days !== 1 ? 's' : ''}`;
  }
}
