/**
 * @packageDocumentation
 * @module TransactionPoller
 * @description
 * Reliable transaction confirmation tracking.
 * 
 * Unlike standard `await tx.wait()`, this poller:
 * - Does NOT block the main thread.
 * - Polls for status updates in the background (every 2s).
 * - Emits events (`pending`, `confirmed`, `failed`) for UI updates.
 * - Handles long-running cross-chain epochs without timing out the application.
 */

export type TransactionStatus = 'pending' | 'confirmed' | 'failed' | 'timeout';

export interface PendingTransaction {
    txHash: string;
    chain: number;
    submittedAt: number;
    status: TransactionStatus;
    confirmations?: number;
    blockNumber?: number;
}

export interface ConfirmationEvent {
    txHash: string;
    status: TransactionStatus;
    confirmations?: number;
    blockNumber?: number;
    error?: string;
}

type ConfirmationCallback = (event: ConfirmationEvent) => void;

export class TransactionPoller {
    private pending: Map<string, PendingTransaction> = new Map();
    private callbacks: Map<string, ConfirmationCallback[]> = new Map();
    private globalCallbacks: ConfirmationCallback[] = [];
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private readonly POLL_INTERVAL_MS = 2000;
    private readonly TIMEOUT_MS = 300000; // 5 minutes
    private checkConfirmation: (txHash: string, chain: number) => Promise<{ confirmed: boolean; confirmations?: number; blockNumber?: number }>;

    constructor(
        confirmationChecker: (txHash: string, chain: number) => Promise<{ confirmed: boolean; confirmations?: number; blockNumber?: number }>
    ) {
        this.checkConfirmation = confirmationChecker;
    }

    /**
     * Start tracking a transaction.
     */
    track(txHash: string, chain: number, callback?: ConfirmationCallback): void {
        const tx: PendingTransaction = {
            txHash,
            chain,
            submittedAt: Date.now(),
            status: 'pending',
        };
        this.pending.set(txHash, tx);

        if (callback) {
            if (!this.callbacks.has(txHash)) {
                this.callbacks.set(txHash, []);
            }
            this.callbacks.get(txHash)!.push(callback);
        }

        this.startPolling();
    }

    /**
     * Subscribe to all confirmation events.
     */
    onConfirmation(callback: ConfirmationCallback): () => void {
        this.globalCallbacks.push(callback);
        return () => {
            const index = this.globalCallbacks.indexOf(callback);
            if (index > -1) {
                this.globalCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * Get status of a tracked transaction.
     */
    getStatus(txHash: string): PendingTransaction | undefined {
        return this.pending.get(txHash);
    }

    /**
     * Get all pending transactions.
     */
    getPending(): PendingTransaction[] {
        return Array.from(this.pending.values()).filter(tx => tx.status === 'pending');
    }

    /**
     * Stop tracking a transaction.
     */
    untrack(txHash: string): void {
        this.pending.delete(txHash);
        this.callbacks.delete(txHash);
        this.maybeStopPolling();
    }

    /**
     * Start the polling loop.
     */
    private startPolling(): void {
        if (this.pollInterval) return;

        this.pollInterval = setInterval(() => {
            this.poll();
        }, this.POLL_INTERVAL_MS);
    }

    /**
     * Stop polling if no pending transactions.
     */
    private maybeStopPolling(): void {
        if (this.getPending().length === 0 && this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    /**
     * Poll all pending transactions.
     */
    private async poll(): Promise<void> {
        const pending = this.getPending();

        for (const tx of pending) {
            try {
                // Check for timeout
                if (Date.now() - tx.submittedAt > this.TIMEOUT_MS) {
                    this.updateStatus(tx.txHash, 'timeout');
                    continue;
                }

                const result = await this.checkConfirmation(tx.txHash, tx.chain);

                if (result.confirmed) {
                    tx.confirmations = result.confirmations;
                    tx.blockNumber = result.blockNumber;
                    this.updateStatus(tx.txHash, 'confirmed');
                }
            } catch (error) {
                console.error(`[TransactionPoller] Error checking ${tx.txHash}:`, error);
                // Don't fail immediately on network errors, just log
            }
        }

        this.maybeStopPolling();
    }

    /**
     * Update transaction status and emit events.
     */
    private updateStatus(txHash: string, status: TransactionStatus, error?: string): void {
        const tx = this.pending.get(txHash);
        if (!tx) return;

        tx.status = status;

        const event: ConfirmationEvent = {
            txHash,
            status,
            confirmations: tx.confirmations,
            blockNumber: tx.blockNumber,
            error,
        };

        // Notify specific callbacks
        const callbacks = this.callbacks.get(txHash) || [];
        callbacks.forEach(cb => cb(event));

        // Notify global callbacks
        this.globalCallbacks.forEach(cb => cb(event));

        // Clean up completed transactions
        if (status !== 'pending') {
            this.callbacks.delete(txHash);
        }
    }

    /**
     * Clean up all resources.
     */
    destroy(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.pending.clear();
        this.callbacks.clear();
        this.globalCallbacks = [];
    }
}
