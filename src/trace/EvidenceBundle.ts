/**
 * @module EvidenceBundle
 * @description
 * Assembles complete evidence bundles for dispute resolution.
 * Promoted from the enterprise demo DisputeExporter with enhancements:
 * - Independent trace hash verification
 * - Multiple export formats (JSON, markdown)
 * - Bundle integrity via bundleHash
 */

import { ethers } from 'ethers';
import type {
  VeridexTracePayload,
  DisputeBundle,
  SettlementProof,
  StorageReceipt,
} from './types';
import type { VerdictResult } from '../policy/types';
import { TraceInterceptor } from './TraceInterceptor';

export class EvidenceBundle {
  private traceInterceptor: TraceInterceptor;

  constructor(traceInterceptor?: TraceInterceptor) {
    this.traceInterceptor = traceInterceptor ?? new TraceInterceptor();
  }

  /**
   * Create a complete evidence bundle.
   */
  create(params: {
    trace: VeridexTracePayload;
    traceHash: `0x${string}`;
    signature: string;
    verdict: VerdictResult;
    settlementProof?: SettlementProof;
    storageReceipt?: StorageReceipt;
  }): DisputeBundle {
    const bundle: Omit<DisputeBundle, 'bundleHash'> = {
      trace: params.trace,
      traceHash: params.traceHash,
      signature: params.signature,
      verdict: params.verdict,
      settlementProof: params.settlementProof,
      storageReceipt: params.storageReceipt,
      assembledAt: Date.now(),
    };

    // Compute bundle hash (tamper detection)
    const bundleHash = this.hashBundle(bundle);

    return { ...bundle, bundleHash };
  }

  /**
   * Verify the integrity of an evidence bundle.
   * Checks:
   * 1. Bundle hash matches content
   * 2. Trace hash matches trace payload
   * 3. Signature is valid (if signer address provided)
   */
  verify(
    bundle: DisputeBundle,
    expectedSignerAddress?: string
  ): { valid: boolean; checks: Array<{ check: string; passed: boolean; reason: string }> } {
    const checks: Array<{ check: string; passed: boolean; reason: string }> = [];

    // 1. Bundle hash integrity
    const { bundleHash: _, ...bundleWithoutHash } = bundle;
    const expectedBundleHash = this.hashBundle(bundleWithoutHash);
    const bundleHashValid = expectedBundleHash === bundle.bundleHash;
    checks.push({
      check: 'Bundle integrity',
      passed: bundleHashValid,
      reason: bundleHashValid ? 'Bundle hash matches' : 'Bundle hash mismatch — possible tampering',
    });

    // 2. Trace hash verification
    const traceHashValid = this.traceInterceptor.verifyTrace(bundle.trace, bundle.traceHash);
    checks.push({
      check: 'Trace hash',
      passed: traceHashValid,
      reason: traceHashValid ? 'Trace hash matches payload' : 'Trace hash does not match payload',
    });

    // 3. Signature verification (if address provided)
    if (expectedSignerAddress) {
      const sigValid = this.traceInterceptor.verifySignature(
        bundle.traceHash,
        bundle.signature,
        expectedSignerAddress
      );
      checks.push({
        check: 'Signature',
        passed: sigValid,
        reason: sigValid
          ? `Valid signature from ${expectedSignerAddress}`
          : `Signature does not match expected signer ${expectedSignerAddress}`,
      });
    }

    return {
      valid: checks.every((c) => c.passed),
      checks,
    };
  }

  /**
   * Export bundle as JSON.
   */
  exportJSON(bundle: DisputeBundle): string {
    return JSON.stringify(bundle, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value
    , 2);
  }

  /**
   * Export bundle as a human-readable markdown report.
   */
  exportMarkdown(bundle: DisputeBundle): string {
    const lines: string[] = [
      '# Veridex Evidence Bundle',
      '',
      '## Summary',
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| **Trace ID** | \`${bundle.trace.traceId}\` |`,
      `| **Timestamp** | ${new Date(bundle.trace.timestamp).toISOString()} |`,
      `| **Agent ID** | ${bundle.trace.agentId ?? 'N/A'} |`,
      `| **Trace Hash** | \`${bundle.traceHash}\` |`,
      `| **Bundle Hash** | \`${bundle.bundleHash}\` |`,
      `| **Verdict** | ${bundle.verdict.verdict.toUpperCase()} (risk: ${bundle.verdict.riskScore}/100) |`,
      '',
      '## Proposed Action',
      '',
      `- **Type:** ${bundle.trace.proposedAction.type}`,
      `- **Recipient:** \`${bundle.trace.proposedAction.recipient}\``,
      `- **Asset:** ${bundle.trace.proposedAction.asset}`,
      `- **Amount:** ${bundle.trace.proposedAction.amount} ($${bundle.trace.proposedAction.amountUSD.toFixed(2)})`,
      `- **Chain:** ${bundle.trace.proposedAction.chain}`,
      `- **Protocol:** ${bundle.trace.proposedAction.protocol}`,
      '',
      '## Policy Evaluation',
      '',
      `**Verdict:** ${bundle.verdict.verdict}`,
      `**Risk Score:** ${bundle.verdict.riskScore}/100`,
      `**Mandate Version:** ${bundle.verdict.mandateVersion}`,
      '',
    ];

    if (bundle.verdict.reasons.length > 0) {
      lines.push('### Reasons');
      lines.push('');
      for (const reason of bundle.verdict.reasons) {
        lines.push(`- ${reason}`);
      }
      lines.push('');
    }

    lines.push('### Checks');
    lines.push('');
    for (const check of bundle.verdict.checks) {
      lines.push(`- ${check.passed ? '✅' : '❌'} **${check.ruleName}**: ${check.reason}`);
    }
    lines.push('');

    if (bundle.trace.reasoning.llmOutput) {
      lines.push('## Agent Reasoning');
      lines.push('');
      lines.push('```');
      lines.push(bundle.trace.reasoning.llmOutput);
      lines.push('```');
      lines.push('');
    }

    if (bundle.settlementProof) {
      lines.push('## Settlement Proof');
      lines.push('');
      lines.push(`- **TX Hash:** \`${bundle.settlementProof.txHash}\``);
      if (bundle.settlementProof.blockNumber) {
        lines.push(`- **Block:** ${bundle.settlementProof.blockNumber}`);
      }
      lines.push(`- **Trace in Calldata:** ${bundle.settlementProof.traceHashInCalldata}`);
      if (bundle.settlementProof.explorerUrl) {
        lines.push(`- **Explorer:** ${bundle.settlementProof.explorerUrl}`);
      }
      lines.push('');
    }

    if (bundle.storageReceipt) {
      lines.push('## Storage Receipt');
      lines.push('');
      lines.push(`- **Provider:** ${bundle.storageReceipt.provider}`);
      lines.push(`- **Content ID:** \`${bundle.storageReceipt.contentId}\``);
      lines.push(`- **Stored At:** ${new Date(bundle.storageReceipt.storedAt).toISOString()}`);
      lines.push(`- **Immutable:** ${bundle.storageReceipt.immutable}`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Generated at ${new Date(bundle.assembledAt).toISOString()}*`);

    return lines.join('\n');
  }

  /** Compute a hash of the bundle content for tamper detection. */
  private hashBundle(bundle: Omit<DisputeBundle, 'bundleHash'>): `0x${string}` {
    const canonical = JSON.stringify(bundle, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
    return ethers.keccak256(ethers.toUtf8Bytes(canonical)) as `0x${string}`;
  }
}
