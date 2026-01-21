/**
 * @packageDocumentation
 * @module AuditLogger
 * @description
 * Immutable transaction logging for compliance and auditing.
 * 
 * Every payment attempt (successful or failed) is recorded here. In a production environment,
 * this should ideally write to a tamper-evident log or database. Currently, it persists
 * to local storage and memory for the demo.
 * 
 * Records:
 * - Timestamp
 * - Amount (USD and Native)
 * - Chain ID
 * - Recipient
 * - Session ID
 */
import { PaymentReceipt, HistoryOptions } from '../types/agent';

export interface PaymentRecord extends PaymentReceipt {
  id: string;
  sessionKeyHash?: string;
}

export class AuditLogger {
  private static readonly STORAGE_KEY = 'veridex_audit_log';
  private inMemoryLogs: PaymentRecord[] = [];

  async log(entry: PaymentReceipt, sessionKeyHash?: string): Promise<void> {
    const record: PaymentRecord = {
      ...entry,
      id: crypto.randomUUID ? crypto.randomUUID() : `log_${Date.now()}_${Math.random()}`,
      sessionKeyHash
    };

    this.inMemoryLogs.push(record);
    this.persistLogs();

    // Original console log
    console.log('AUDIT:', JSON.stringify(record, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    ));
  }

  async getLogs(options: HistoryOptions = {}): Promise<PaymentRecord[]> {
    this.loadLogs();
    let logs = [...this.inMemoryLogs];

    // Filter by chain
    if (options.chain !== undefined) {
      logs = logs.filter(l => l.chain === options.chain);
    }

    // Filter by time
    if (options.startTime) {
      logs = logs.filter(l => l.timestamp >= options.startTime!);
    }
    if (options.endTime) {
      logs = logs.filter(l => l.timestamp <= options.endTime!);
    }

    // Sort desc
    logs.sort((a, b) => b.timestamp - a.timestamp);

    // Pagination
    const offset = options.offset || 0;
    const limit = options.limit || 50;

    return logs.slice(offset, offset + limit);
  }

  private persistLogs() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AuditLogger.STORAGE_KEY, JSON.stringify(this.inMemoryLogs));
    }
  }

  private loadLogs() {
    if (typeof localStorage !== 'undefined') {
      const data = localStorage.getItem(AuditLogger.STORAGE_KEY);
      if (data) {
        this.inMemoryLogs = JSON.parse(data);
      }
    }
  }
}
