/**
 * @packageDocumentation
 * @module Performance
 * @description
 * Performance optimization utilities for high-frequency agent operations.
 * 
 * Exports:
 * - {@link TransactionQueue}: Batch processing.
 * - {@link NonceManager}: Optimistic concurrency control.
 * - {@link ConnectionPool}: HTTP resource management.
 * - {@link ParallelRouteFinder}: Fast multi-chain discovery.
 */

export { NonceManager } from './NonceManager';
export {
    TransactionQueue,
    type QueuedTransaction,
    type BatchResult,
    type TransactionPayload,
    type TransactionResult,
    type QueueConfig,
    type TransactionExecutor,
    type TransactionPriority,
    type TransactionStatus as QueueTransactionStatus,
} from './TransactionQueue';
export {
    TransactionPoller,
    type PendingTransaction,
    type ConfirmationEvent,
    type TransactionStatus as PollerTransactionStatus,
} from './TransactionPoller';
export {
    ConnectionPool,
    type PoolConfig,
    type PoolStats,
    getConnectionPool,
    createConnectionPool,
} from './ConnectionPool';
export {
    ParallelRouteFinder,
    type ChainBalance,
    type RouteCandidate,
    type RouteHop,
    type RouteFindingConfig,
    type RouteFindingResult,
} from './ParallelRouteFinder';
