/**
 * @packageDocumentation
 * @module ComplianceExporter
 * @description
 * Utilities for exporting audit logs in regulatory-friendly formats.
 * 
 * Supports exporting transaction history as:
 * - **JSON**: For machine ingestion.
 * - **CSV**: For spreadsheet analysis and reporting.
 */
import { PaymentRecord } from './AuditLogger';

export class ComplianceExporter {
    exportToJSON(records: PaymentRecord[]): string {
        return JSON.stringify(records, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value,
            2);
    }

    exportToCSV(records: PaymentRecord[]): string {
        if (records.length === 0) return '';

        const headers = [
            'id',
            'timestamp',
            'protocol',
            'status',
            'chain',
            'token',
            'amount',
            'recipient',
            'sessionKeyHash'
        ];

        const rows = records.map(r => [
            r.id,
            new Date(r.timestamp).toISOString(),
            r.protocol || 'direct',
            r.status,
            r.chain,
            r.token,
            r.amount.toString(),
            r.recipient,
            r.sessionKeyHash || ''
        ].map(val => {
            const str = String(val);
            return str.includes(',') ? `"${str}"` : str;
        }).join(','));

        return [headers.join(','), ...rows].join('\n');
    }
}
