/**
 * @module JSONFileStorage
 * JSON file-based trace storage adapter for local development and self-hosting.
 * Stores each trace as a separate JSON file on disk.
 *
 * Node.js only — uses dynamic import for `fs` and `path` modules.
 */

import { ethers } from 'ethers';
import type { TraceStorageAdapter, VeridexTracePayload, StorageReceipt } from '../types';

export interface JSONFileStorageConfig {
  /** Directory path where trace files are stored */
  directory: string;
}

export class JSONFileStorage implements TraceStorageAdapter {
  private directory: string;
  private fsReady: Promise<typeof import('node:fs/promises')> | null = null;
  private pathReady: Promise<typeof import('node:path')> | null = null;

  constructor(config: JSONFileStorageConfig) {
    this.directory = config.directory;
  }

  private async getFs() {
    if (!this.fsReady) {
      this.fsReady = import('node:fs/promises');
    }
    return this.fsReady;
  }

  private async getPath() {
    if (!this.pathReady) {
      this.pathReady = import('node:path');
    }
    return this.pathReady;
  }

  private async ensureDirectory(): Promise<void> {
    const fs = await this.getFs();
    await fs.mkdir(this.directory, { recursive: true });
  }

  private async filePath(contentId: string): Promise<string> {
    const path = await this.getPath();
    // Sanitize contentId to prevent path traversal
    const safe = contentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.directory, `${safe}.json`);
  }

  async store(trace: VeridexTracePayload, traceHash: string): Promise<StorageReceipt> {
    await this.ensureDirectory();
    const fs = await this.getFs();

    const contentId = `file-${trace.traceId}`;
    const storedAt = Date.now();
    const data = JSON.stringify({ trace, traceHash, storedAt }, null, 2);
    const fp = await this.filePath(contentId);

    await fs.writeFile(fp, data, 'utf-8');

    return {
      provider: 'json-file',
      contentId,
      storedAt,
      immutable: false,
    };
  }

  async retrieve(contentId: string): Promise<VeridexTracePayload | null> {
    const fs = await this.getFs();
    const fp = await this.filePath(contentId);

    try {
      const raw = await fs.readFile(fp, 'utf-8');
      const data = JSON.parse(raw) as { trace: VeridexTracePayload };
      return data.trace ?? null;
    } catch {
      return null;
    }
  }

  async verify(contentId: string, expectedHash: string): Promise<boolean> {
    const fs = await this.getFs();
    const fp = await this.filePath(contentId);

    try {
      const raw = await fs.readFile(fp, 'utf-8');
      const parsed = JSON.parse(raw) as { traceHash?: string; trace?: VeridexTracePayload };

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
