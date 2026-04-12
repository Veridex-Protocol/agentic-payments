/**
 * @module FilecoinStorage
 * Filecoin Onchain Cloud trace storage adapter using the Synapse SDK.
 *
 * Uses the @filoz/synapse-sdk for upload/download via Filecoin's
 * Proof of Data Possession (PDP) warm storage service.
 *
 * The adapter accepts a pre-configured Synapse storage client instance
 * to avoid a hard dependency on the SDK. Users initialize the SDK themselves:
 *
 * ```ts
 * import { Synapse } from '@filoz/synapse-sdk';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const synapse = Synapse.create({ account: privateKeyToAccount('0x...'), source: 'veridex' });
 * const storage = new FilecoinStorage({ client: synapse.storage });
 * ```
 *
 * @see https://docs.filecoin.cloud/getting-started/
 * @see https://docs.filecoin.cloud/developer-guides/storage/storage-operations/
 */

import { ethers } from 'ethers';
import type { TraceStorageAdapter, VeridexTracePayload, StorageReceipt } from '../types';

/**
 * Minimal interface for the Synapse SDK storage manager.
 * Matches the subset of `synapse.storage` methods we need.
 * Users pass in their own initialized Synapse storage instance.
 */
export interface SynapseStorageClient {
  /** Upload data to Filecoin warm storage with multi-copy durability. */
  upload(
    data: Uint8Array,
    options?: {
      metadata?: Record<string, string>;
      pieceMetadata?: Record<string, string>;
      copies?: number;
    },
  ): Promise<{
    pieceCid: { toString(): string };
    size: number;
    complete: boolean;
    copies: Array<{ providerId: bigint; dataSetId: bigint; role: string }>;
  }>;

  /** Download data by its PieceCID from any provider that has it. */
  download(options: { pieceCid: string; withCDN?: boolean }): Promise<Uint8Array>;
}

export interface FilecoinStorageConfig {
  /** Pre-configured Synapse storage client (synapse.storage). */
  client: SynapseStorageClient;
  /** Data set metadata for organizing traces (optional). */
  metadata?: Record<string, string>;
  /** Number of copies for durability (default: 2). */
  copies?: number;
  /** Enable CDN for faster retrieval (default: false). */
  withCDN?: boolean;
}

export class FilecoinStorage implements TraceStorageAdapter {
  private client: SynapseStorageClient;
  private metadata: Record<string, string>;
  private copies: number;
  private withCDN: boolean;

  constructor(config: FilecoinStorageConfig) {
    this.client = config.client;
    this.metadata = config.metadata ?? { source: 'veridex-agent-sdk', type: 'trace' };
    this.copies = config.copies ?? 2;
    this.withCDN = config.withCDN ?? false;
  }

  async store(trace: VeridexTracePayload, traceHash: string): Promise<StorageReceipt> {
    const payload = JSON.stringify({ trace, traceHash });
    const data = new TextEncoder().encode(payload);

    const result = await this.client.upload(data, {
      metadata: this.metadata,
      pieceMetadata: {
        traceId: trace.traceId,
        traceHash,
        contentType: 'application/json',
      },
      copies: this.copies,
    });

    const pieceCid = result.pieceCid.toString();

    return {
      provider: 'filecoin-cloud',
      contentId: pieceCid,
      storedAt: Date.now(),
      immutable: true,
    };
  }

  async retrieve(contentId: string): Promise<VeridexTracePayload | null> {
    try {
      const bytes = await this.client.download({
        pieceCid: contentId,
        withCDN: this.withCDN,
      });
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text) as { trace?: VeridexTracePayload };
      return parsed.trace ?? null;
    } catch {
      return null;
    }
  }

  async verify(contentId: string, expectedHash: string): Promise<boolean> {
    try {
      const bytes = await this.client.download({
        pieceCid: contentId,
        withCDN: this.withCDN,
      });
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text) as { traceHash?: string; trace?: VeridexTracePayload };

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
