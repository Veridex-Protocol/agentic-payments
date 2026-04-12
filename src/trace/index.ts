/**
 * @packageDocumentation
 * @module Trace
 * @description
 * Trace & Evidence Layer — cryptographically verifiable audit trail
 * for every agent decision.
 */

// Core
export { TraceInterceptor } from './TraceInterceptor';
export { EvidenceBundle } from './EvidenceBundle';
export type {
  VeridexTracePayload,
  TraceResult,
  ToolCallRecord,
  ReasoningContext,
  DisputeBundle,
  SettlementProof,
  StorageReceipt,
  TraceStorageAdapter,
} from './types';

// Storage Adapters
export { MemoryStorage } from './storage/MemoryStorage';
export { ArweaveStorage } from './storage/ArweaveStorage';
export type { ArweaveStorageConfig } from './storage/ArweaveStorage';
export { IPFSStorage } from './storage/IPFSStorage';
export type { IPFSStorageConfig } from './storage/IPFSStorage';
export { FilecoinStorage } from './storage/FilecoinStorage';
export type { FilecoinStorageConfig, SynapseStorageClient } from './storage/FilecoinStorage';
export { StorachaStorage } from './storage/StorachaStorage';
export type { StorachaStorageConfig, StorachaUploadClient } from './storage/StorachaStorage';
export { AkaveStorage } from './storage/AkaveStorage';
export type { AkaveStorageConfig } from './storage/AkaveStorage';
export { PostgresStorage } from './storage/PostgresStorage';
export type { PostgresStorageConfig, PostgresQueryExecutor } from './storage/PostgresStorage';
export { JSONFileStorage } from './storage/JSONFileStorage';
export type { JSONFileStorageConfig } from './storage/JSONFileStorage';
