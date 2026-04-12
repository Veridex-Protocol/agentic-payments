/**
 * @module MemoryStorage
 * In-memory trace storage adapter for development and testing.
 * Traces are lost when the process exits.
 */

import { ethers } from 'ethers';
import type { TraceStorageAdapter, VeridexTracePayload, StorageReceipt } from '../types';

export class MemoryStorage implements TraceStorageAdapter {
  private _entries = new Map<string, { trace: VeridexTracePayload; hash: string }>();

  async store(trace: VeridexTracePayload, traceHash: string): Promise<StorageReceipt> {
    const contentId = `mem-${trace.traceId}`;
    this._entries.set(contentId, { trace, hash: traceHash });

    return {
      provider: 'memory',
      contentId,
      storedAt: Date.now(),
      immutable: false,
    };
  }

  async retrieve(contentId: string): Promise<VeridexTracePayload | null> {
    return this._entries.get(contentId)?.trace ?? null;
  }

  async verify(contentId: string, expectedHash: string): Promise<boolean> {
    const entry = this._entries.get(contentId);
    if (!entry) return false;
    return entry.hash === expectedHash;
  }

  /** Get the number of stored traces. */
  size(): number {
    return this._entries.size;
  }

  /** Clear all stored traces. */
  clear(): void {
    this._entries.clear();
  }
}
