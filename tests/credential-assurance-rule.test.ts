import { describe, expect, it } from 'vitest';
import { CredentialAssuranceRule } from '../src/policy/rules/CredentialAssuranceRule';
import type {
  AssurancePolicy,
  CredentialContext,
  EvaluationContext,
  Mandate,
  ProposedAction,
} from '../src/policy/types';
import type { StoredSession } from '../src/session/SessionStorage';

const session: StoredSession = {
  keyHash: '0xsession',
  encryptedPrivateKey: 'enc',
  publicKey: '0xpub',
  config: {
    dailyLimitUSD: 1000,
    perTransactionLimitUSD: 500,
    expiryTimestamp: Date.now() + 86_400_000,
    allowedChains: [10004],
  },
  metadata: {
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    totalSpentUSD: 0,
    dailySpentUSD: 0,
    dailyResetAt: Date.now(),
    transactionCount: 0,
  },
  masterKeyHash: '0xmaster',
};

function makeMandate(assurance?: AssurancePolicy): Mandate {
  return {
    id: 'm1',
    version: '1.0.0',
    name: 'test mandate',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    issuer: 'test',
    allowedAssets: [],
    allowedChains: [],
    allowedCounterparties: [],
    allowedProtocols: [],
    limits: { perTransaction: 500, daily: 1000 },
    timeWindows: [],
    escalation: { riskScoreThreshold: 70, amountUSDThreshold: 100, timeoutMs: 60_000 },
    circuitBreaker: {
      consecutiveBlocksToTrip: 3,
      halfOpenMaxAttempts: 1,
      cooldownMs: 60_000,
      tripOnInjection: true,
      tripOnAnomaly: true,
    },
    assurance,
  };
}

function makeAction(amountUSD: number, type: ProposedAction['type'] = 'payment'): ProposedAction {
  return {
    type,
    recipient: 'https://merchant.example/data',
    asset: 'USDC',
    amount: String(amountUSD * 1_000_000),
    amountUSD,
    chain: 10004,
    protocol: 'x402',
  };
}

function makeCtx(
  credential: CredentialContext | undefined,
  mandate: Mandate,
  action: ProposedAction,
): EvaluationContext {
  return { action, session, mandate, credential, timestamp: Date.now() };
}

const deviceBound: CredentialContext = {
  keyHash: '0xmaster',
  level: 'device-bound',
  backupEligible: false,
  backupState: false,
};

const synced: CredentialContext = {
  keyHash: '0xmaster',
  level: 'synced',
  backupEligible: true,
  backupState: true,
};

describe('CredentialAssuranceRule', () => {
  const rule = new CredentialAssuranceRule();

  it('passes when no assurance policy is configured (backward compatible)', async () => {
    const check = await rule.evaluate(makeCtx(synced, makeMandate(), makeAction(10_000)));

    expect(check.verdict).toBe('pass');
    expect(check.passed).toBe(true);
  });

  it('always passes a device-bound credential', async () => {
    const mandate = makeMandate({ syncedMaxPerTransactionUSD: 50 });
    const check = await rule.evaluate(makeCtx(deviceBound, mandate, makeAction(9_999)));

    expect(check.verdict).toBe('pass');
  });

  it('passes a synced credential below its per-transaction cap', async () => {
    const mandate = makeMandate({ syncedMaxPerTransactionUSD: 50 });
    const check = await rule.evaluate(makeCtx(synced, mandate, makeAction(25)));

    expect(check.verdict).toBe('pass');
  });

  it('escalates a synced credential above its per-transaction cap', async () => {
    const mandate = makeMandate({ syncedMaxPerTransactionUSD: 50 });
    const check = await rule.evaluate(makeCtx(synced, mandate, makeAction(500)));

    expect(check.verdict).toBe('escalate');
    expect(check.passed).toBe(false);
    expect(check.reason).toContain('capped at $50');
    expect(check.metadata?.syncedMaxPerTransactionUSD).toBe(50);
  });

  it('blocks instead of escalating when onExceed is block', async () => {
    const mandate = makeMandate({ syncedMaxPerTransactionUSD: 50, onExceed: 'block' });
    const check = await rule.evaluate(makeCtx(synced, mandate, makeAction(500)));

    expect(check.verdict).toBe('block');
  });

  it('blocks a synced credential from an action type that requires device-bound', async () => {
    const mandate = makeMandate({ requireDeviceBoundFor: ['approval'], onExceed: 'block' });
    const check = await rule.evaluate(makeCtx(synced, mandate, makeAction(1, 'approval')));

    expect(check.verdict).toBe('block');
    expect(check.reason).toContain('requires a device-bound credential');
  });

  it('allows a device-bound credential to perform a device-bound-only action', async () => {
    const mandate = makeMandate({ requireDeviceBoundFor: ['approval'], onExceed: 'block' });
    const check = await rule.evaluate(makeCtx(deviceBound, mandate, makeAction(1, 'approval')));

    expect(check.verdict).toBe('pass');
  });

  it('flags an action when credential assurance is unknown', async () => {
    const mandate = makeMandate({ syncedMaxPerTransactionUSD: 50 });
    const check = await rule.evaluate(makeCtx(undefined, mandate, makeAction(10)));

    expect(check.verdict).toBe('flag');
    expect(check.reason).toContain('unknown');
  });

  it('honours onUnknown when assurance cannot be determined', async () => {
    const mandate = makeMandate({ syncedMaxPerTransactionUSD: 50, onUnknown: 'block' });
    const check = await rule.evaluate(makeCtx(undefined, mandate, makeAction(10)));

    expect(check.verdict).toBe('block');
  });
});
