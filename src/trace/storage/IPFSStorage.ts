/**
 * @module IPFSStorage
 * IPFS trace storage adapter using the HTTP API (Kubo/Pinata/Infura).
 * Content-addressed storage — the CID is deterministic for identical data.
 */

import { ethers } from 'ethers';
import type { TraceStorageAdapter, VeridexTracePayload, StorageReceipt } from '../types';

export interface IPFSStorageConfig {
  /** IPFS HTTP API endpoint (e.g. http://localhost:5001, https://ipfs.infura.io:5001) */
  apiUrl: string;
  /** Optional gateway URL for retrieval (default: https://ipfs.io) */
  gatewayUrl?: string;
  /** Optional auth header value (e.g. "Basic <base64>") */
  authHeader?: string;
}

export class IPFSStorage implements TraceStorageAdapter {
  private apiUrl: string;
  private gatewayUrl: string;
  private authHeader?: string;

  constructor(config: IPFSStorageConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.gatewayUrl = (config.gatewayUrl ?? 'https://ipfs.io').replace(/\/$/, '');
    this.authHeader = config.authHeader;
  }

  async store(trace: VeridexTracePayload, traceHash: string): Promise<StorageReceipt> {
    const payload = JSON.stringify({ trace, traceHash });
    const blob = new Blob([payload], { type: 'application/json' });
    const formData = new FormData();
    formData.append('file', blob, `${trace.traceId}.json`);

    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }

    const response = await fetch(`${this.apiUrl}/api/v0/add?pin=true`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`IPFS upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { Hash: string };

    return {
      provider: 'ipfs',
      contentId: result.Hash,
      storedAt: Date.now(),
      immutable: true,
    };
  }

  async retrieve(contentId: string): Promise<VeridexTracePayload | null> {
    const response = await fetch(`${this.gatewayUrl}/ipfs/${contentId}`);
    if (!response.ok) return null;

    const data = await response.json() as { trace: VeridexTracePayload };
    return data.trace ?? null;
  }

  async verify(contentId: string, expectedHash: string): Promise<boolean> {
    const response = await fetch(`${this.gatewayUrl}/ipfs/${contentId}`);
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
