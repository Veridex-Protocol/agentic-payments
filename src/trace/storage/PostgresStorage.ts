/**
 * @module PostgresStorage
 * PostgreSQL trace storage adapter for self-hosted deployments.
 * Uses raw SQL via a configurable query executor — no ORM dependency.
 */

import { ethers } from 'ethers';
import type { TraceStorageAdapter, VeridexTracePayload, StorageReceipt } from '../types';

/** A minimal query interface — compatible with pg, postgres.js, drizzle, etc. */
export interface PostgresQueryExecutor {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PostgresStorageConfig {
  /** Query executor instance */
  db: PostgresQueryExecutor;
  /** Table name (default: veridex_traces) */
  tableName?: string;
  /** Whether to auto-create the table on first use */
  autoCreateTable?: boolean;
}

export class PostgresStorage implements TraceStorageAdapter {
  private db: PostgresQueryExecutor;
  private tableName: string;
  private tableReady = false;
  private autoCreate: boolean;

  constructor(config: PostgresStorageConfig) {
    this.db = config.db;
    this.tableName = config.tableName ?? 'veridex_traces';
    this.autoCreate = config.autoCreateTable ?? true;
  }

  private async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    if (!this.autoCreate) {
      this.tableReady = true;
      return;
    }

    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
        content_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        trace_hash TEXT NOT NULL,
        trace_data JSONB NOT NULL,
        stored_at BIGINT NOT NULL
      )`,
      []
    );
    this.tableReady = true;
  }

  async store(trace: VeridexTracePayload, traceHash: string): Promise<StorageReceipt> {
    await this.ensureTable();

    const contentId = `pg-${trace.traceId}`;
    const storedAt = Date.now();

    await this.db.query(
      `INSERT INTO ${this.tableName} (content_id, trace_id, trace_hash, trace_data, stored_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (content_id) DO UPDATE SET trace_data = $4, trace_hash = $3, stored_at = $5`,
      [contentId, trace.traceId, traceHash, JSON.stringify(trace), storedAt]
    );

    return {
      provider: 'postgresql',
      contentId,
      storedAt,
      immutable: false,
    };
  }

  async retrieve(contentId: string): Promise<VeridexTracePayload | null> {
    await this.ensureTable();

    const result = await this.db.query(
      `SELECT trace_data FROM ${this.tableName} WHERE content_id = $1`,
      [contentId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const traceData = typeof row.trace_data === 'string'
      ? JSON.parse(row.trace_data)
      : row.trace_data;

    return traceData as VeridexTracePayload;
  }

  async verify(contentId: string, expectedHash: string): Promise<boolean> {
    await this.ensureTable();

    const result = await this.db.query(
      `SELECT trace_hash FROM ${this.tableName} WHERE content_id = $1`,
      [contentId]
    );

    if (result.rows.length === 0) return false;
    return result.rows[0].trace_hash === expectedHash;
  }
}
