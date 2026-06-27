/**
 * PolicyAttestation tests — signed verdict bound to a payment, enforced at the
 * signer in warn-only (default) and enforce modes (Gap 1).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PaymentAttestationGuard,
  computeIntentHash,
  signAttestation,
  canonicalAttestationPayload,
  type PolicyAttestation,
  type AttestationSigner,
  type AttestationVerifier,
} from '../src/protected/PolicyAttestation';

const encoder = new TextEncoder();

/** Minimal HMAC signer+verifier for tests. */
function makeSigner(secret = 'attestation-secret'): AttestationSigner & AttestationVerifier {
  const keyPromise = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const hex = (b: ArrayBuffer) =>
    Array.from(new Uint8Array(b))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  return {
    verificationMethod: 'veridex:policy:test',
    async sign(payload: string) {
      return hex(await crypto.subtle.sign('HMAC', await keyPromise, encoder.encode(payload)));
    },
    async verify(payload: string, signature: string) {
      const expected = hex(
        await crypto.subtle.sign('HMAC', await keyPromise, encoder.encode(payload)),
      );
      return expected === signature;
    },
  };
}

const intent = { chain: 1, recipient: '0xabc', token: 'USDC', amount: '5.00' };

async function allowAttestation(
  signer: AttestationSigner,
  intentHash: string,
  overrides: Partial<PolicyAttestation> = {},
): Promise<PolicyAttestation> {
  return signAttestation(
    {
      intentHash,
      verdict: 'allow',
      policyId: 'treasury-pack@1',
      issuedAt: Date.now(),
      ...overrides,
    },
    signer,
  );
}

describe('computeIntentHash', () => {
  it('is deterministic and key-order independent', async () => {
    const a = await computeIntentHash(intent);
    const b = await computeIntentHash({ amount: '5.00', token: 'USDC', recipient: '0xabc', chain: 1 });
    expect(a).toBe(b);
  });

  it('changes when any field changes', async () => {
    const a = await computeIntentHash(intent);
    const b = await computeIntentHash({ ...intent, amount: '6.00' });
    expect(a).not.toBe(b);
  });
});

describe('PaymentAttestationGuard — enforce mode', () => {
  it('allows a valid, bound, signed allow attestation', async () => {
    const signer = makeSigner();
    const guard = new PaymentAttestationGuard({ verifier: signer, mode: 'enforce' });
    const intentHash = await computeIntentHash(intent);
    const att = await allowAttestation(signer, intentHash);

    const decision = await guard.authorizeSign({ intentHash, attestation: att });
    expect(decision.allowed).toBe(true);
    expect(decision.verified).toBe(true);
  });

  it('refuses to sign when no attestation is supplied', async () => {
    const signer = makeSigner();
    const guard = new PaymentAttestationGuard({ verifier: signer, mode: 'enforce' });
    const intentHash = await computeIntentHash(intent);

    const decision = await guard.authorizeSign({ intentHash });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/no policy attestation/i);
  });

  it('rejects an attestation bound to a different payment', async () => {
    const signer = makeSigner();
    const guard = new PaymentAttestationGuard({ verifier: signer, mode: 'enforce' });
    const otherHash = await computeIntentHash({ ...intent, amount: '999' });
    const att = await allowAttestation(signer, otherHash);
    const intentHash = await computeIntentHash(intent);

    const decision = await guard.authorizeSign({ intentHash, attestation: att });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/not bound to this payment/i);
  });

  it('rejects a forged/tampered attestation signature', async () => {
    const signer = makeSigner();
    const guard = new PaymentAttestationGuard({ verifier: signer, mode: 'enforce' });
    const intentHash = await computeIntentHash(intent);
    const att = await allowAttestation(signer, intentHash);
    att.riskScore = 0; // mutate after signing → signature no longer matches

    const decision = await guard.authorizeSign({ intentHash, attestation: att });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/signature is invalid/i);
  });

  it('rejects an expired attestation', async () => {
    const signer = makeSigner();
    const guard = new PaymentAttestationGuard({ verifier: signer, mode: 'enforce' });
    const intentHash = await computeIntentHash(intent);
    const att = await allowAttestation(signer, intentHash, { expiresAt: Date.now() - 1 });

    const decision = await guard.authorizeSign({ intentHash, attestation: att });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/expired/i);
  });
});

describe('PaymentAttestationGuard — warn mode (default)', () => {
  it('signs anyway but warns when the attestation is missing', async () => {
    const signer = makeSigner();
    const onWarn = vi.fn();
    const guard = new PaymentAttestationGuard({ verifier: signer, onWarn });
    const intentHash = await computeIntentHash(intent);

    const decision = await guard.authorizeSign({ intentHash });
    expect(decision.allowed).toBe(true);
    expect(decision.verified).toBe(false);
    expect(decision.warnings.length).toBeGreaterThan(0);
    expect(onWarn).toHaveBeenCalled();
  });

  it('still HARD-BLOCKS an explicit deny verdict even in warn mode', async () => {
    const signer = makeSigner();
    const guard = new PaymentAttestationGuard({ verifier: signer, mode: 'warn' });
    const intentHash = await computeIntentHash(intent);
    const att = await signAttestation(
      { intentHash, verdict: 'deny', issuedAt: Date.now() },
      signer,
    );

    const decision = await guard.authorizeSign({ intentHash, attestation: att });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/deny/i);
  });
});

describe('TEE quote verification', () => {
  it('blocks (enforce) when a present TEE quote fails to verify', async () => {
    const signer = makeSigner();
    const teeVerifier = { verify: vi.fn(async () => false) };
    const guard = new PaymentAttestationGuard({ verifier: signer, teeVerifier, mode: 'enforce' });
    const intentHash = await computeIntentHash(intent);
    const att = await allowAttestation(signer, intentHash, {
      tee: { quote: 'bogus-quote', format: 'nitro' },
    });

    const decision = await guard.authorizeSign({ intentHash, attestation: att });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/TEE quote/i);
    expect(teeVerifier.verify).toHaveBeenCalledWith('bogus-quote', 'nitro');
  });

  it('passes when the TEE quote verifies', async () => {
    const signer = makeSigner();
    const teeVerifier = { verify: vi.fn(async () => true) };
    const guard = new PaymentAttestationGuard({ verifier: signer, teeVerifier, mode: 'enforce' });
    const intentHash = await computeIntentHash(intent);
    const att = await allowAttestation(signer, intentHash, {
      tee: { quote: 'good-quote' },
    });

    const decision = await guard.authorizeSign({ intentHash, attestation: att });
    expect(decision.allowed).toBe(true);
    expect(decision.verified).toBe(true);
  });
});

describe('canonicalAttestationPayload', () => {
  it('excludes the signature field so it can be recomputed for verification', async () => {
    const signer = makeSigner();
    const intentHash = await computeIntentHash(intent);
    const att = await allowAttestation(signer, intentHash);
    expect(canonicalAttestationPayload(att)).not.toContain(att.signature);
  });
});
