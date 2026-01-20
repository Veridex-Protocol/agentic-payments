/**
 * Performance Module Tests
 * 
 * Tests for NonceManager, TransactionQueue, and TransactionPoller.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NonceManager } from '../src/performance/NonceManager';
import { TransactionQueue } from '../src/performance/TransactionQueue';
import { TransactionPoller } from '../src/performance/TransactionPoller';

describe('NonceManager', () => {
    let manager: NonceManager;

    beforeEach(() => {
        manager = new NonceManager();
    });

    describe('getNextNonce', () => {
        it('should return 0 for fresh key', () => {
            const nonce = manager.getNextNonce('key1');
            expect(nonce).toBe(BigInt(0));
        });

        it('should use on-chain value when provided', () => {
            const nonce = manager.getNextNonce('key1', BigInt(5));
            expect(nonce).toBe(BigInt(5));
        });

        it('should use cached value on subsequent calls', () => {
            manager.getNextNonce('key1', BigInt(5));
            const nonce = manager.getNextNonce('key1');
            expect(nonce).toBe(BigInt(5));
        });

        it('should skip pending nonces', () => {
            manager.reserveNonce('key1', BigInt(0));
            manager.reserveNonce('key1', BigInt(1));
            const nonce = manager.getNextNonce('key1');
            expect(nonce).toBe(BigInt(2));
        });
    });

    describe('reserveNonce and releaseNonce', () => {
        it('should reserve and release nonces', () => {
            manager.reserveNonce('key1', BigInt(0));
            expect(manager.getPendingNonces('key1')).toContain(BigInt(0));

            manager.releaseNonce('key1', BigInt(0));
            expect(manager.getPendingNonces('key1')).not.toContain(BigInt(0));
        });
    });

    describe('confirmNonce', () => {
        it('should update cache on confirmation', () => {
            manager.reserveNonce('key1', BigInt(0));
            manager.confirmNonce('key1', BigInt(0));

            expect(manager.getPendingNonces('key1')).not.toContain(BigInt(0));

            const nextNonce = manager.getNextNonce('key1');
            expect(nextNonce).toBe(BigInt(1));
        });
    });

    describe('clearCache', () => {
        it('should clear all data for a key', () => {
            manager.getNextNonce('key1', BigInt(5));
            manager.reserveNonce('key1', BigInt(5));

            manager.clearCache('key1');

            expect(manager.getNextNonce('key1')).toBe(BigInt(0));
            expect(manager.getPendingNonces('key1')).toHaveLength(0);
        });
    });
});

describe('TransactionQueue', () => {
    let queue: TransactionQueue;

    beforeEach(() => {
        queue = new TransactionQueue({ batchSize: 5, batchDelayMs: 10 });
    });

    afterEach(async () => {
        await queue.shutdown({ waitForPending: false });
        queue.clear();
    });

    describe('enqueue', () => {
        it('should add transaction to queue', () => {
            const id = queue.enqueue({
                keyHash: 'key1',
                payload: {
                    recipient: '0x123',
                    amount: '100',
                    token: 'USDC',
                    chain: 30,
                },
                priority: 'normal',
            });

            expect(id).toBeDefined();
            expect(id).toMatch(/^tx_/);
            const tx = queue.get(id);
            expect(tx?.status).toBe('pending');
        });
    });

    describe('cancel', () => {
        it('should cancel pending transaction', () => {
            const id = queue.enqueue({
                keyHash: 'key1',
                payload: {
                    recipient: '0x123',
                    amount: '100',
                    token: 'USDC',
                    chain: 30,
                },
                priority: 'normal',
            });

            const cancelled = queue.cancel(id);
            expect(cancelled).toBe(true);
            expect(queue.get(id)?.status).toBe('cancelled');
        });

        it('should return false for non-existent transaction', () => {
            const cancelled = queue.cancel('non-existent');
            expect(cancelled).toBe(false);
        });
    });

    describe('flush', () => {
        it('should process all pending transactions', async () => {
            queue.enqueue({
                keyHash: 'key1',
                payload: { recipient: '0x1', amount: '10', token: 'USDC', chain: 30 },
                priority: 'normal',
            });
            queue.enqueue({
                keyHash: 'key1',
                payload: { recipient: '0x2', amount: '20', token: 'USDC', chain: 30 },
                priority: 'high',
            });

            const results = await queue.flush();

            expect(results.length).toBeGreaterThan(0);
            expect(results[0].successCount).toBe(2);
        });
    });

    describe('getStats', () => {
        it('should return queue statistics', async () => {
            queue.enqueue({
                keyHash: 'key1',
                payload: { recipient: '0x1', amount: '10', token: 'USDC', chain: 30 },
                priority: 'normal',
            });

            const statsBefore = queue.getStats();
            expect(statsBefore.pending).toBe(1);

            await queue.flush();

            const statsAfter = queue.getStats();
            expect(statsAfter.completed).toBe(1);
            expect(statsAfter.pending).toBe(0);
        });
    });

    describe('dead letter queue', () => {
        it('should move failed transactions to dead letter queue', async () => {
            // Create queue with executor that always fails
            const failingQueue = new TransactionQueue(
                { batchSize: 5, batchDelayMs: 10, defaultMaxAttempts: 1 },
                {
                    execute: () => Promise.reject(new Error('Always fails')),
                }
            );

            failingQueue.enqueue({
                keyHash: 'key1',
                payload: { recipient: '0x1', amount: '10', token: 'USDC', chain: 30 },
                priority: 'normal',
            });

            await failingQueue.flush();

            const dlq = failingQueue.getDeadLetterQueue();
            expect(dlq.length).toBe(1);
            expect(dlq[0].lastError).toBe('Always fails');

            await failingQueue.shutdown({ waitForPending: false });
        });
    });

    describe('events', () => {
        it('should emit events during processing', async () => {
            const events: string[] = [];

            queue.on('transaction:enqueued', () => events.push('enqueued'));
            queue.on('transaction:processing', () => events.push('processing'));
            queue.on('transaction:completed', () => events.push('completed'));
            queue.on('batch:completed', () => events.push('batch'));

            queue.enqueue({
                keyHash: 'key1',
                payload: { recipient: '0x1', amount: '10', token: 'USDC', chain: 30 },
                priority: 'normal',
            });

            expect(events).toContain('enqueued');

            await queue.flush();

            expect(events).toContain('processing');
            expect(events).toContain('completed');
            expect(events).toContain('batch');
        });
    });
});

describe('TransactionPoller', () => {
    let poller: TransactionPoller;
    let mockChecker: ReturnType<typeof vi.fn<[string, number], Promise<{ confirmed: boolean; confirmations?: number; blockNumber?: number }>>>;

    beforeEach(() => {
        mockChecker = vi.fn().mockResolvedValue({ confirmed: false });
        poller = new TransactionPoller(mockChecker);
    });

    afterEach(() => {
        poller.destroy();
    });

    describe('track', () => {
        it('should start tracking a transaction', () => {
            poller.track('0x123', 30);

            const status = poller.getStatus('0x123');
            expect(status).toBeDefined();
            expect(status?.status).toBe('pending');
        });

        it('should call callback on confirmation', async () => {
            mockChecker.mockResolvedValueOnce({ confirmed: true, confirmations: 1, blockNumber: 100 });

            const callback = vi.fn();
            poller.track('0x123', 30, callback);

            // Wait for poll cycle
            await new Promise(resolve => setTimeout(resolve, 2500));

            expect(callback).toHaveBeenCalled();
            expect(callback).toHaveBeenCalledWith(
                expect.objectContaining({
                    txHash: '0x123',
                    status: 'confirmed',
                })
            );
        });
    });

    describe('untrack', () => {
        it('should stop tracking a transaction', () => {
            poller.track('0x123', 30);
            poller.untrack('0x123');

            expect(poller.getStatus('0x123')).toBeUndefined();
        });
    });

    describe('onConfirmation', () => {
        it('should subscribe to global events', async () => {
            mockChecker.mockResolvedValueOnce({ confirmed: true, confirmations: 1 });

            const globalCallback = vi.fn();
            const unsubscribe = poller.onConfirmation(globalCallback);

            poller.track('0x456', 30);

            // Wait for poll cycle
            await new Promise(resolve => setTimeout(resolve, 2500));

            expect(globalCallback).toHaveBeenCalled();

            unsubscribe();
        });
    });

    describe('getPending', () => {
        it('should return all pending transactions', () => {
            poller.track('0x111', 30);
            poller.track('0x222', 30);

            const pending = poller.getPending();
            expect(pending).toHaveLength(2);
        });
    });
});
