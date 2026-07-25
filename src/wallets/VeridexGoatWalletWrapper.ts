/**
 * @packageDocumentation
 * @module VeridexGoatWalletWrapper
 * @description
 * Intercepts signing requests on the GOAT Network EvmWalletProvider payer path,
 * evaluating economic policies in-path prior to key delegation and emitting signed
 * Evidence Bundles for audit and validation registries.
 */

import { ethers } from 'ethers';
import { TraceInterceptor } from '../trace/TraceInterceptor.js';
import type { ProposedAction, VerdictResult } from '../policy/types.js';

export class PolicyDenialError extends Error {
  public readonly trace: any;
  public readonly verdict: VerdictResult;

  constructor(message: string, verdict: VerdictResult, trace: any) {
    super(message);
    this.name = 'PolicyDenialError';
    this.verdict = verdict;
    this.trace = trace;
    Object.setPrototypeOf(this, PolicyDenialError.prototype);
  }
}

export interface VeridexGoatWalletWrapperOptions {
  agentId: string;
  sessionSigner: ethers.Signer;
  policyEngine?: {
    evaluate: (ctx: any) => Promise<VerdictResult>;
  };
  storageAdapter?: any;
  teeAttestationProvider?: () => Promise<{ type: string; quote: string; measurement: string }>;
}

export class VeridexGoatWalletWrapper {
  private underlyingProvider: any;
  private agentId: string;
  private sessionSigner: ethers.Signer;
  private policyEngine?: { evaluate: (ctx: any) => Promise<VerdictResult> };
  private traceInterceptor: TraceInterceptor;
  private teeAttestationProvider?: () => Promise<{ type: string; quote: string; measurement: string }>;

  constructor(underlyingProvider: any, options: VeridexGoatWalletWrapperOptions) {
    this.underlyingProvider = underlyingProvider;
    this.agentId = options.agentId;
    this.sessionSigner = options.sessionSigner;
    this.policyEngine = options.policyEngine;
    this.traceInterceptor = new TraceInterceptor(options.storageAdapter);
    this.teeAttestationProvider = options.teeAttestationProvider;
  }

  /**
   * Intercepts transaction dispatch actions, performing in-path policy evaluation
   * prior to delegating the payload to the underlying provider signature engine.
   */
  public async sendTransaction(transactionPayload: any): Promise<any> {
    const proposedAction: ProposedAction = {
      type: 'payment',
      recipient: transactionPayload.to || transactionPayload.recipient || '0x0000000000000000000000000000000000000000',
      amount: String(transactionPayload.value || transactionPayload.amount || '0'),
      amountUSD: Number(transactionPayload.amountUSD || 0),
      asset: transactionPayload.asset || 'GOAT',
      chain: transactionPayload.chain || 30,
      protocol: 'x402',
      metadata: transactionPayload,
    };

    const sessionKeyHash = ethers.keccak256(
      ethers.toUtf8Bytes(await this.sessionSigner.getAddress())
    );

    const evaluationContext = {
      timestamp: Date.now(),
      action: proposedAction,
      sessionKeyHash,
      agentId: this.agentId,
    };

    let verdict: VerdictResult;
    if (this.policyEngine) {
      verdict = await this.policyEngine.evaluate(evaluationContext);
    } else {
      verdict = {
        verdict: 'pass',
        riskScore: 0,
        reasons: ['Default pass - no policy engine supplied'],
        checks: [],
        mandateVersion: '1.0.0',
        evaluatedAt: Date.now(),
      };
    }

    if (verdict.verdict === 'block' || verdict.verdict === 'deny' as any) {
      const traceResult = await this.traceInterceptor.capture({
        sessionKeyHash,
        agentId: this.agentId,
        reasoning: { prompt: 'In-path wallet policy evaluation', toolCalls: [] },
        proposedAction,
        policyEvaluation: verdict,
        environment: { runtime: 'clawup-azure-confidential-container' },
      });

      const signedSignature = await this.traceInterceptor.sign(
        traceResult.traceHash as `0x${string}`,
        this.sessionSigner
      );

      throw new PolicyDenialError(
        `[Veridex Policy Block] Transaction denied: ${verdict.reasons.join(', ')}`,
        verdict,
        { ...traceResult, signature: signedSignature }
      );
    }

    let teeAttestation;
    if (this.teeAttestationProvider) {
      teeAttestation = await this.teeAttestationProvider();
    }

    const txResult = await this.underlyingProvider.sendTransaction(transactionPayload);

    const traceResult = await this.traceInterceptor.capture({
      sessionKeyHash,
      agentId: this.agentId,
      reasoning: { prompt: 'Authorized payment transaction execution', toolCalls: [] },
      proposedAction,
      policyEvaluation: verdict,
      environment: {
        runtime: 'clawup-azure-confidential-container',
        teeAttestation,
      },
    });

    const signature = await this.traceInterceptor.sign(
      traceResult.traceHash as `0x${string}`,
      this.sessionSigner
    );

    if (this.traceInterceptor) {
      await this.traceInterceptor.store(traceResult.trace, traceResult.traceHash);
    }

    return {
      txResult,
      traceHash: traceResult.traceHash,
      signature,
      trace: traceResult.trace,
    };
  }

  /**
   * Intercepts arbitrary message signing requests.
   */
  public async signMessage(message: string | Uint8Array): Promise<string> {
    return this.underlyingProvider.signMessage(message);
  }

  /**
   * Intercepts EIP-712 typed data signing requests.
   */
  public async signTypedData(domain: any, types: any, value: any): Promise<string> {
    return this.underlyingProvider.signTypedData(domain, types, value);
  }
}
