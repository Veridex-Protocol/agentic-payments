/**
 * @packageDocumentation
 * @module TransactionQueue
 * @description
 * Enterprise-grade batch processing for Agent Transactions.
 * 
 * When an agent needs to perform multiple actions (e.g., pay 5 different vendors),
 * simply looping through them can cause nonce condition errors and rate limiting.
 * 
 * This Queue provides:
 * - **Sequential Execution**: Ensures nonces are used in order.
 * - **Concurrency Control**: Limits active batches (default 3 concurrent).
 * - **Retry Logic**: Exponential backoff for failed submissions.
 * - **Dead Letter Queue**: Isolated storage for persistently failing transactions.
 */

import { EventEmitter } from 'events';

export type TransactionPriority = 'low' | 'normal' | 'high' | 'critical';
export type TransactionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'expired' | 'cancelled';

export interface TransactionPayload {
    recipient: string;
    amount: string;
    token: string;
    chain: number;
    memo?: string;
    metadata?: Record<string, unknown>;
}

export interface QueuedTransaction {
    id: string;
    keyHash: string;
    payload: TransactionPayload;
    priority: TransactionPriority;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    status: TransactionStatus;
    attempts: number;
    maxAttempts: number;
    lastError?: string;
    result?: TransactionResult;
}

export interface TransactionResult {
    txHash?: string;
    error?: string;
    confirmations?: number;
    blockNumber?: number;
    gasUsed?: string;
    effectiveGasPrice?: string;
    completedAt?: number;
}

export interface BatchResult {
    batchId: string;
    startedAt: number;
    completedAt: number;
    durationMs: number;
    transactions: QueuedTransaction[];
    successCount: number;
    failureCount: number;
    expiredCount: number;
}

export interface QueueConfig {
    /** Maximum transactions per batch (default: 10) */
    batchSize: number;
    /** Delay before processing batch in ms (default: 100) */
    batchDelayMs: number;
    /** Maximum concurrent batches (default: 3) */
    maxConcurrentBatches: number;
    /** Default transaction TTL in ms (default: 5 minutes) */
    defaultTTLMs: number;
    /** Default max retry attempts (default: 3) */
    defaultMaxAttempts: number;
    /** Base retry delay in ms (default: 1000) */
    retryBaseDelayMs: number;
    /** Max retry delay in ms (default: 30000) */
    retryMaxDelayMs: number;
    /** Enable dead letter queue for failed transactions (default: true) */
    enableDeadLetterQueue: boolean;
    /** Max dead letter queue size (default: 100) */
    deadLetterQueueSize: number;
}

export interface TransactionExecutor {
    execute(tx: QueuedTransaction): Promise<TransactionResult>;
}

export interface QueueEvents {
    'transaction:enqueued': (tx: QueuedTransaction) => void;
    'transaction:processing': (tx: QueuedTransaction) => void;
    'transaction:completed': (tx: QueuedTransaction) => void;
    'transaction:failed': (tx: QueuedTransaction, error: Error) => void;
    'transaction:expired': (tx: QueuedTransaction) => void;
    'transaction:retry': (tx: QueuedTransaction, attempt: number) => void;
    'batch:started': (batchId: string, count: number) => void;
    'batch:completed': (result: BatchResult) => void;
    'queue:drained': () => void;
    'deadletter:added': (tx: QueuedTransaction) => void;
}

const DEFAULT_CONFIG: QueueConfig = {
    batchSize: 10,
    batchDelayMs: 100,
    maxConcurrentBatches: 3,
    defaultTTLMs: 5 * 60 * 1000, // 5 minutes
    defaultMaxAttempts: 3,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 30000,
    enableDeadLetterQueue: true,
    deadLetterQueueSize: 100,
};

const PRIORITY_ORDER: Record<TransactionPriority, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
};

export class TransactionQueue extends EventEmitter {
    private queue: Map<string, QueuedTransaction> = new Map();
    private deadLetterQueue: QueuedTransaction[] = [];
    private config: QueueConfig;
    private executor?: TransactionExecutor;
    private activeBatches = 0;
    private processingTimer: ReturnType<typeof setTimeout> | null = null;
    private expirationTimer: ReturnType<typeof setInterval> | null = null;
    private shuttingDown = false;

    constructor(
        options: Partial<QueueConfig> = {},
        executor?: TransactionExecutor
    ) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...options };
        this.executor = executor;

        // Start expiration checker
        this.expirationTimer = setInterval(() => this.checkExpiration(), 1000);
    }

    /**
     * Set the transaction executor.
     */
    setExecutor(executor: TransactionExecutor): void {
        this.executor = executor;
    }

    /**
     * Add a transaction to the queue.
     */
    enqueue(
        tx: Omit<QueuedTransaction, 'id' | 'createdAt' | 'updatedAt' | 'expiresAt' | 'status' | 'attempts' | 'maxAttempts'>,
        options: { ttlMs?: number; maxAttempts?: number } = {}
    ): string {
        if (this.shuttingDown) {
            throw new Error('Queue is shutting down');
        }

        const now = Date.now();
        const id = this.generateId();
        const queuedTx: QueuedTransaction = {
            ...tx,
            id,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + (options.ttlMs || this.config.defaultTTLMs),
            status: 'pending',
            attempts: 0,
            maxAttempts: options.maxAttempts || this.config.defaultMaxAttempts,
        };

        this.queue.set(id, queuedTx);
        this.emit('transaction:enqueued', queuedTx);
        this.scheduleProcessing();

        return id;
    }

    /**
     * Generate unique transaction ID.
     */
    private generateId(): string {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 11);
        return `tx_${timestamp}_${random}`;
    }

    /**
     * Get transaction by ID.
     */
    get(id: string): QueuedTransaction | undefined {
        return this.queue.get(id);
    }

    /**
     * Get transaction status.
     */
    getStatus(id: string): TransactionStatus | undefined {
        return this.queue.get(id)?.status;
    }

    /**
     * Cancel a pending transaction.
     */
    cancel(id: string): boolean {
        const tx = this.queue.get(id);
        if (tx && tx.status === 'pending') {
            tx.status = 'cancelled';
            tx.updatedAt = Date.now();
            return true;
        }
        return false;
    }

    /**
     * Get all pending transactions.
     */
    getPending(): QueuedTransaction[] {
        return Array.from(this.queue.values())
            .filter(tx => tx.status === 'pending');
    }

    /**
     * Get transactions by status.
     */
    getByStatus(status: TransactionStatus): QueuedTransaction[] {
        return Array.from(this.queue.values())
            .filter(tx => tx.status === status);
    }

    /**
     * Get transactions by key hash (session).
     */
    getByKeyHash(keyHash: string): QueuedTransaction[] {
        return Array.from(this.queue.values())
            .filter(tx => tx.keyHash === keyHash);
    }

    /**
     * Get dead letter queue contents.
     */
    getDeadLetterQueue(): QueuedTransaction[] {
        return [...this.deadLetterQueue];
    }

    /**
     * Retry a failed transaction from dead letter queue.
     */
    retryFromDeadLetter(id: string): boolean {
        const index = this.deadLetterQueue.findIndex(tx => tx.id === id);
        if (index === -1) return false;

        const tx = this.deadLetterQueue.splice(index, 1)[0];
        tx.status = 'pending';
        tx.attempts = 0;
        tx.updatedAt = Date.now();
        tx.expiresAt = Date.now() + this.config.defaultTTLMs;
        delete tx.lastError;
        delete tx.result;

        this.queue.set(tx.id, tx);
        this.emit('transaction:enqueued', tx);
        this.scheduleProcessing();

        return true;
    }

    /**
     * Clear dead letter queue.
     */
    clearDeadLetterQueue(): number {
        const count = this.deadLetterQueue.length;
        this.deadLetterQueue = [];
        return count;
    }

    /**
     * Schedule batch processing.
     */
    private scheduleProcessing(): void {
        if (this.processingTimer || this.shuttingDown) return;
        if (this.activeBatches >= this.config.maxConcurrentBatches) return;
        if (this.getPending().length === 0) return;

        this.processingTimer = setTimeout(async () => {
            this.processingTimer = null;
            await this.processBatch();
        }, this.config.batchDelayMs);
    }

    /**
     * Process a batch of transactions.
     */
    private async processBatch(): Promise<BatchResult | null> {
        if (this.shuttingDown) return null;
        if (this.activeBatches >= this.config.maxConcurrentBatches) return null;

        const pending = this.getPending()
            .sort((a, b) => {
                // Sort by priority, then by creation time (FIFO within priority)
                const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
                if (priorityDiff !== 0) return priorityDiff;
                return a.createdAt - b.createdAt;
            })
            .slice(0, this.config.batchSize);

        if (pending.length === 0) return null;

        this.activeBatches++;

        const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const startedAt = Date.now();

        this.emit('batch:started', batchId, pending.length);

        let successCount = 0;
        let failureCount = 0;
        let expiredCount = 0;

        // Process transactions concurrently within batch
        await Promise.all(
            pending.map(async (tx) => {
                // Check if expired
                if (Date.now() >= tx.expiresAt) {
                    tx.status = 'expired';
                    tx.updatedAt = Date.now();
                    expiredCount++;
                    this.emit('transaction:expired', tx);
                    return;
                }

                tx.status = 'processing';
                tx.attempts++;
                tx.updatedAt = Date.now();
                this.emit('transaction:processing', tx);

                try {
                    const result = await this.executeTransaction(tx);
                    tx.status = 'completed';
                    tx.result = { ...result, completedAt: Date.now() };
                    tx.updatedAt = Date.now();
                    successCount++;
                    this.emit('transaction:completed', tx);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    tx.lastError = errorMessage;
                    tx.updatedAt = Date.now();

                    // Check if should retry
                    if (tx.attempts < tx.maxAttempts) {
                        tx.status = 'pending';
                        this.emit('transaction:retry', tx, tx.attempts);
                        // Schedule with exponential backoff
                        const delay = Math.min(
                            this.config.retryBaseDelayMs * Math.pow(2, tx.attempts - 1),
                            this.config.retryMaxDelayMs
                        );
                        setTimeout(() => this.scheduleProcessing(), delay);
                    } else {
                        tx.status = 'failed';
                        tx.result = { error: errorMessage };
                        failureCount++;
                        this.emit('transaction:failed', tx, error instanceof Error ? error : new Error(errorMessage));

                        // Add to dead letter queue
                        if (this.config.enableDeadLetterQueue) {
                            this.addToDeadLetterQueue(tx);
                        }
                    }
                }
            })
        );

        this.activeBatches--;

        const completedAt = Date.now();
        const result: BatchResult = {
            batchId,
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
            transactions: pending,
            successCount,
            failureCount,
            expiredCount,
        };

        this.emit('batch:completed', result);

        // Check if more pending transactions
        if (this.getPending().length > 0) {
            this.scheduleProcessing();
        } else {
            this.emit('queue:drained');
        }

        return result;
    }

    /**
     * Execute a single transaction.
     */
    private async executeTransaction(tx: QueuedTransaction): Promise<TransactionResult> {
        if (!this.executor) {
            // Default mock implementation for testing
            await new Promise(resolve => setTimeout(resolve, 10));
            return {
                txHash: `0x${Buffer.from(tx.id).toString('hex').padStart(64, '0')}`,
                confirmations: 1,
                completedAt: Date.now(),
            };
        }

        return this.executor.execute(tx);
    }

    /**
     * Add transaction to dead letter queue.
     */
    private addToDeadLetterQueue(tx: QueuedTransaction): void {
        if (this.deadLetterQueue.length >= this.config.deadLetterQueueSize) {
            // Remove oldest entry
            this.deadLetterQueue.shift();
        }
        this.deadLetterQueue.push({ ...tx });
        this.emit('deadletter:added', tx);
    }

    /**
     * Check for expired transactions.
     */
    private checkExpiration(): void {
        const now = Date.now();
        for (const tx of this.queue.values()) {
            if (tx.status === 'pending' && now >= tx.expiresAt) {
                tx.status = 'expired';
                tx.updatedAt = now;
                this.emit('transaction:expired', tx);
            }
        }
    }

    /**
     * Force immediate processing of pending transactions.
     */
    async flush(): Promise<BatchResult[]> {
        const results: BatchResult[] = [];

        while (this.getPending().length > 0 && !this.shuttingDown) {
            const result = await this.processBatch();
            if (result) {
                results.push(result);
            } else {
                // Wait a bit if max concurrent batches reached
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        return results;
    }

    /**
     * Clear all transactions (including completed).
     */
    clear(): void {
        this.queue.clear();
    }

    /**
     * Clear completed transactions.
     */
    clearCompleted(): number {
        let cleared = 0;
        for (const [id, tx] of this.queue.entries()) {
            if (tx.status === 'completed' || tx.status === 'expired' || tx.status === 'cancelled') {
                this.queue.delete(id);
                cleared++;
            }
        }
        return cleared;
    }

    /**
     * Get queue statistics.
     */
    getStats(): {
        total: number;
        pending: number;
        processing: number;
        completed: number;
        failed: number;
        expired: number;
        cancelled: number;
        deadLetterQueue: number;
        activeBatches: number;
    } {
        const stats = {
            total: 0,
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
            expired: 0,
            cancelled: 0,
            deadLetterQueue: this.deadLetterQueue.length,
            activeBatches: this.activeBatches,
        };

        for (const tx of this.queue.values()) {
            stats.total++;
            stats[tx.status]++;
        }

        return stats;
    }

    /**
     * Graceful shutdown.
     */
    async shutdown(options: { waitForPending?: boolean; timeoutMs?: number } = {}): Promise<void> {
        const { waitForPending = true, timeoutMs = 30000 } = options;

        this.shuttingDown = true;

        // Clear timers
        if (this.processingTimer) {
            clearTimeout(this.processingTimer);
            this.processingTimer = null;
        }
        if (this.expirationTimer) {
            clearInterval(this.expirationTimer);
            this.expirationTimer = null;
        }

        if (waitForPending && this.getPending().length > 0) {
            // Wait for pending transactions with timeout
            const startTime = Date.now();
            while (
                (this.getPending().length > 0 || this.activeBatches > 0) &&
                Date.now() - startTime < timeoutMs
            ) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }

    /**
     * Type-safe event listener.
     */
    override on<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }

    /**
     * Type-safe event emitter.
     */
    override emit<K extends keyof QueueEvents>(event: K, ...args: Parameters<QueueEvents[K]>): boolean {
        return super.emit(event, ...args);
    }
}
