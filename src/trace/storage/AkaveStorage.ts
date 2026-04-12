/**
 * @module AkaveStorage
 * Akave decentralized storage adapter for traces.
 * Uses the Akave HTTP API for on-chain cloud storage.
 */

import { ethers } from 'ethers';
import type { TraceStorageAdapter, VeridexTracePayload, StorageReceipt } from '../types';

export interface AkaveStorageConfig {
  /** Akave API endpoint */
  apiUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Bucket name for storing traces */
  bucket: string;
}

export class AkaveStorage implements TraceStorageAdapter {
  private apiUrl: string;
  private apiKey: string;
  private bucket: string;

  constructor(config: AkaveStorageConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.bucket = config.bucket;
  }

  async store(trace: VeridexTracePayload, traceHash: string): Promise<StorageReceipt> {
    const payload = JSON.stringify({ trace, traceHash });
    const objectKey = `traces/${trace.traceId}.json`;

    const response = await fetch(`${this.apiUrl}/buckets/${this.bucket}/files`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Object-Key': objectKey,
      },
      body: payload,
    });

    if (!response.ok) {
      throw new Error(`Akave upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { cid?: string; key?: string };
    const contentId = result.cid ?? result.key ?? objectKey;

    return {
      provider: 'akave',
      contentId,
      storedAt: Date.now(),
      immutable: true,
    };
  }

  async retrieve(contentId: string): Promise<VeridexTracePayload | null> {
    const response = await fetch(`${this.apiUrl}/buckets/${this.bucket}/files/${contentId}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });
    if (!response.ok) return null;

    const data = await response.json() as { trace: VeridexTracePayload };
    return data.trace ?? null;
  }

  async verify(contentId: string, expectedHash: string): Promise<boolean> {
    const response = await fetch(`${this.apiUrl}/buckets/${this.bucket}/files/${contentId}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });
    if (!response.ok) return false;

    const body = await response.text();
    const parsed = JSON.parse(body) as { traceHash?: string; trace?: VeridexTracePayload };

    if (parsed.traceHash) {
      return parsed.traceHash === expectedHash;
    }

    if (parsed.trace) {
      const canonical = JSON.stringify(parsed.trace, Object.keys(parsed.trace).sort());
      const computed = ethers.keccak256(ethers.toUtf8Bytes(canonical));
      return computed === expectedHash;
    }

    return false;
  }
}
