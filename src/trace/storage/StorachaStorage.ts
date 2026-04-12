/**
 * @module StorachaStorage
 * Storacha (formerly web3.storage) trace storage adapter.
 *
 * Uses the @storacha/client SDK for UCAN-authorized content-addressed uploads.
 * Retrieval is via IPFS gateways (default: storacha.link).
 *
 * The adapter accepts a pre-configured Storacha client instance to avoid a hard
 * dependency on the SDK. Users initialize the client and Space themselves:
 *
 * ```ts
 * import * as Client from '@storacha/client';
 * import * as Proof from '@storacha/client/proof';
 * import { Signer } from '@storacha/client/principal/ed25519';
 * import { StoreMemory } from '@storacha/client/stores/memory';
 *
 * const principal = Signer.parse(process.env.KEY);
 * const store = new StoreMemory();
 * const client = await Client.create({ principal, store });
 * const proof = await Proof.parse(process.env.PROOF);
 * const space = await client.addSpace(proof);
 * await client.setCurrentSpace(space.did());
 *
 * const storage = new StorachaStorage({ client });
 * ```
 *
 * @see https://docs.storacha.network/js-client/
 * @see https://docs.storacha.network/concepts/ucans-and-storacha/
 * @see https://docs.storacha.network/concepts/architecture-options/
 */

import { ethers } from 'ethers';
import type { TraceStorageAdapter, VeridexTracePayload, StorageReceipt } from '../types';

/**
 * Minimal interface for the @storacha/client.
 * Matches the subset of methods we need for trace storage.
 * Users pass in their own initialized and Space-configured client.
 */
export interface StorachaUploadClient {
  /**
   * Upload a single file. Returns a CID that can be used for IPFS gateway retrieval.
   * @see https://github.com/storacha/upload-service/tree/main/packages/w3up-client#uploadfile
   */
  uploadFile(file: Blob): Promise<{ toString(): string }>;
}

export interface StorachaStorageConfig {
  /** Pre-configured @storacha/client instance with a current Space set. */
  client: StorachaUploadClient;
  /**
   * IPFS gateway host for retrieval (default: 'w3s.link').
   * Files are retrieved at: https://{cid}.ipfs.{gatewayHost}
   */
  gatewayHost?: string;
}

export class StorachaStorage implements TraceStorageAdapter {
  private client: StorachaUploadClient;
  private gatewayHost: string;

  constructor(config: StorachaStorageConfig) {
    this.client = config.client;
    this.gatewayHost = (config.gatewayHost ?? 'w3s.link').replace(/\/$/, '');
  }

  async store(trace: VeridexTracePayload, traceHash: string): Promise<StorageReceipt> {
    const payload = JSON.stringify({ trace, traceHash });
    const blob = new Blob([payload], { type: 'application/json' });

    const cid = await this.client.uploadFile(blob);
    const contentId = cid.toString();

    return {
      provider: 'storacha',
      contentId,
      storedAt: Date.now(),
      immutable: true,
    };
  }

  async retrieve(contentId: string): Promise<VeridexTracePayload | null> {
    try {
      const url = `https://${contentId}.ipfs.${this.gatewayHost}`;
      const response = await fetch(url);
      if (!response.ok) return null;

      const data = await response.json() as { trace?: VeridexTracePayload };
      return data.trace ?? null;
    } catch {
      return null;
    }
  }

  async verify(contentId: string, expectedHash: string): Promise<boolean> {
    try {
      const url = `https://${contentId}.ipfs.${this.gatewayHost}`;
      const response = await fetch(url);
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
    } catch {
      return false;
    }
  }
}
