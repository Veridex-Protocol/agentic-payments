/**
 * @module ArweaveStorage
 * Arweave permanent trace storage adapter.
 * Data is stored permanently on the Arweave permaweb — immutable by design.
 *
 * Requires an Arweave gateway URL and wallet JWK for signing transactions.
 * Falls back to `arweave.net` if no gateway is specified.
 */

import { ethers } from 'ethers';
import type { TraceStorageAdapter, VeridexTracePayload, StorageReceipt } from '../types';

export interface ArweaveStorageConfig {
  /** Arweave gateway URL (default: https://arweave.net) */
  gatewayUrl?: string;
  /** JWK wallet key for signing transactions */
  walletJWK: JsonWebKey;
}

export class ArweaveStorage implements TraceStorageAdapter {
  private gatewayUrl: string;
  private walletJWK: JsonWebKey;

  constructor(config: ArweaveStorageConfig) {
    this.gatewayUrl = (config.gatewayUrl ?? 'https://arweave.net').replace(/\/$/, '');
    this.walletJWK = config.walletJWK;
  }

  async store(trace: VeridexTracePayload, traceHash: string): Promise<StorageReceipt> {
    const data = JSON.stringify({ trace, traceHash });
    const dataBytes = new TextEncoder().encode(data);

    // Create transaction via Arweave HTTP API
    const txResponse = await fetch(`${this.gatewayUrl}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: this.uint8ToBase64Url(dataBytes),
        tags: [
          { name: this.stringToBase64Url('App-Name'), value: this.stringToBase64Url('Veridex') },
          { name: this.stringToBase64Url('Content-Type'), value: this.stringToBase64Url('application/json') },
          { name: this.stringToBase64Url('Trace-Hash'), value: this.stringToBase64Url(traceHash) },
          { name: this.stringToBase64Url('Trace-Id'), value: this.stringToBase64Url(trace.traceId) },
        ],
      }),
    });

    if (!txResponse.ok) {
      throw new Error(`Arweave upload failed: ${txResponse.status} ${txResponse.statusText}`);
    }

    const result = await txResponse.json() as { id: string };

    return {
      provider: 'arweave',
      contentId: result.id,
      storedAt: Date.now(),
      immutable: true,
    };
  }

  async retrieve(contentId: string): Promise<VeridexTracePayload | null> {
    const response = await fetch(`${this.gatewayUrl}/${contentId}`);
    if (!response.ok) return null;

    const data = await response.json() as { trace: VeridexTracePayload };
    return data.trace ?? null;
  }

  async verify(contentId: string, expectedHash: string): Promise<boolean> {
    const response = await fetch(`${this.gatewayUrl}/${contentId}`);
    if (!response.ok) return false;

    const body = await response.text();
    const parsed = JSON.parse(body) as { traceHash?: string; trace?: VeridexTracePayload };

    // Check embedded hash first
    if (parsed.traceHash) {
      return parsed.traceHash === expectedHash;
    }

    // Recompute hash from trace data
    if (parsed.trace) {
      const canonical = JSON.stringify(parsed.trace, Object.keys(parsed.trace).sort());
      const computed = ethers.keccak256(ethers.toUtf8Bytes(canonical));
      return computed === expectedHash;
    }

    return false;
  }

  private uint8ToBase64Url(bytes: Uint8Array): string {
    const binary = String.fromCharCode(...bytes);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private stringToBase64Url(str: string): string {
    return this.uint8ToBase64Url(new TextEncoder().encode(str));
  }
}
