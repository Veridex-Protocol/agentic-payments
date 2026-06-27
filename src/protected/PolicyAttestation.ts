/**
 * @module @veridex/agentic-payments/protected/PolicyAttestation
 *
 * Closes the **local-host bypass / policy-attestation** gap
 * (agent_fabric_gap_analysis.md, Gap 1).
 *
 * When the policy engine and the payment signer run in the same process, a host
 * attacker can tamper the in-memory policy result and force a signature. The
 * defence is to make the signer require a *cryptographically signed allow
 * verdict bound to the exact payload it is about to sign* — so a verdict cannot
 * be forged or replayed onto a different transaction.
 *
 * The {@link PolicyEngine} emits a {@link PolicyAttestation} (verdict + intent
 * hash + optional TEE quote, signed). {@link PaymentAttestationGuard} checks it
 * at sign time.
 *
 * Rollout is **warn-only by default**: a missing/invalid/mismatched attestation
 * is logged but signing proceeds, so existing callers that don't yet produce
 * attestations keep working. Flip `mode: 'enforce'` to make the signer refuse.
 * One exception that holds in *both* modes: an explicit `deny` verdict is always
 * a hard block — the signer never signs something policy actively denied.
 */

const encoder = new TextEncoder();

/** Stable, sorted-key JSON for deterministic hashing/signing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 hex digest of a string. */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
}

/** The payload a verdict authorizes. Hash this to bind a verdict to a payment. */
export interface PaymentIntent {
  chain: number | string;
  recipient: string;
  token: string;
  amount: string;
  nonce?: string | number;
}

/** Deterministic intent hash binding an attestation to one specific payment. */
export async function computeIntentHash(intent: PaymentIntent): Promise<string> {
  return sha256Hex(canonicalJson(intent));
}

/** A signed policy verdict authorizing (or denying) a specific payment. */
export interface PolicyAttestation {
  /** Hash of the {@link PaymentIntent} this verdict is bound to. */
  intentHash: string;
  verdict: 'allow' | 'deny';
  riskScore?: number;
  /** Policy engine / pack identifier + version, for evidence. */
  policyId?: string;
  issuedAt: number;
  expiresAt?: number;
  /** Optional TEE quote proving the verdict ran inside an enclave. */
  tee?: { quote: string; format?: string };
  /** Detached signature over the canonical attestation (minus signature). */
  signature?: string;
  verificationMethod?: string;
}

export interface AttestationSigner {
  readonly verificationMethod: string;
  sign(payload: string): Promise<string>;
}

export interface AttestationVerifier {
  verify(payload: string, signature: string, verificationMethod: string): Promise<boolean>;
}

/** Verifies a TEE quote carried by an attestation (e.g. Nitro/SEV-SNP). */
export interface TeeQuoteVerifier {
  verify(quote: string, format?: string): Promise<boolean>;
}

/** Canonical bytes an attestation signature is computed over (minus signature). */
export function canonicalAttestationPayload(att: PolicyAttestation): string {
  const { signature: _s, ...rest } = att;
  return canonicalJson(rest);
}

export async function signAttestation(
  att: PolicyAttestation,
  signer: AttestationSigner,
): Promise<PolicyAttestation> {
  const signed: PolicyAttestation = { ...att, verificationMethod: signer.verificationMethod };
  signed.signature = await signer.sign(canonicalAttestationPayload(signed));
  return signed;
}

export type AttestationEnforcement = 'enforce' | 'warn';

export interface PaymentAttestationGuardOptions {
  verifier: AttestationVerifier;
  /** Optional TEE quote verifier; when set, a present `tee` quote must verify. */
  teeVerifier?: TeeQuoteVerifier;
  /** `warn` (default): log and proceed. `enforce`: refuse to sign. */
  mode?: AttestationEnforcement;
  now?: () => number;
  /** Called with each warning in `warn` mode. Defaults to `console.warn`. */
  onWarn?: (message: string, intentHash: string) => void;
}

export interface AttestationDecision {
  /** Whether signing may proceed. */
  allowed: boolean;
  /** Whether a valid, bound, allow attestation was verified. */
  verified: boolean;
  /** Reasons signing was blocked (enforce mode, or a deny verdict). */
  reasons: string[];
  /** Non-fatal issues surfaced in warn mode. */
  warnings: string[];
}

/**
 * Gate consulted by the payment signer immediately before signing. Verifies the
 * policy attestation is present, signed, unexpired, an `allow`, and bound to the
 * exact payment being signed.
 */
export class PaymentAttestationGuard {
  private readonly verifier: AttestationVerifier;
  private readonly teeVerifier?: TeeQuoteVerifier;
  private readonly mode: AttestationEnforcement;
  private readonly now: () => number;
  private readonly onWarn: (message: string, intentHash: string) => void;

  constructor(options: PaymentAttestationGuardOptions) {
    this.verifier = options.verifier;
    this.teeVerifier = options.teeVerifier;
    this.mode = options.mode ?? 'warn';
    this.now = options.now ?? Date.now;
    this.onWarn =
      options.onWarn ?? ((message) => console.warn(`[PaymentAttestationGuard] ${message}`));
  }

  async authorizeSign(params: {
    intentHash: string;
    attestation?: PolicyAttestation;
  }): Promise<AttestationDecision> {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const { intentHash, attestation } = params;

    // Collect every problem; severity (block vs warn) is decided by mode below,
    // with an explicit `deny` verdict always blocking.
    let hardDeny = false;

    if (!attestation) {
      reasons.push('no policy attestation supplied for this payment');
    } else {
      if (attestation.verdict === 'deny') {
        hardDeny = true;
        reasons.push(`policy attestation verdict is "deny"${attestation.policyId ? ` (${attestation.policyId})` : ''}`);
      }
      if (attestation.intentHash !== intentHash) {
        reasons.push('policy attestation is not bound to this payment (intent hash mismatch)');
      }
      if (attestation.expiresAt !== undefined && this.now() > attestation.expiresAt) {
        reasons.push('policy attestation has expired');
      }
      if (!attestation.signature || !attestation.verificationMethod) {
        reasons.push('policy attestation is unsigned');
      } else {
        const ok = await this.verifier.verify(
          canonicalAttestationPayload(attestation),
          attestation.signature,
          attestation.verificationMethod,
        );
        if (!ok) reasons.push('policy attestation signature is invalid');
      }
      if (attestation.tee && this.teeVerifier) {
        const teeOk = await this.teeVerifier.verify(attestation.tee.quote, attestation.tee.format);
        if (!teeOk) reasons.push('TEE quote on the policy attestation failed verification');
      }
    }

    const verified = reasons.length === 0;
    if (verified) {
      return { allowed: true, verified: true, reasons: [], warnings: [] };
    }

    // An explicit deny is a hard block regardless of mode.
    if (hardDeny || this.mode === 'enforce') {
      return { allowed: false, verified: false, reasons, warnings };
    }

    // warn mode: surface the issues but allow signing to proceed.
    for (const r of reasons) {
      warnings.push(r);
      this.onWarn(`${r} — signing anyway (mode=warn)`, intentHash);
    }
    return { allowed: true, verified: false, reasons: [], warnings };
  }
}
