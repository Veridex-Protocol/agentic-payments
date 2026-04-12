/**
 * @packageDocumentation
 * @module Security
 * @description
 * Security Firewall — detects prompt injection, tool poisoning,
 * secret exfiltration, and anomalous transaction patterns.
 */

export { InjectionDetector } from './InjectionDetector';
export type {
  InjectionResult,
  InjectionMatch,
  InjectionCategory,
} from './InjectionDetector';

export { AnomalyDetector } from './AnomalyDetector';
export type {
  AnomalyConfig,
  AnomalyResult,
  AnomalyDetail,
  AnomalyType,
  BehaviorFingerprint,
  FingerprintScore,
  ActionObservation,
} from './AnomalyDetector';

export { ToolSanitizer } from './ToolSanitizer';
export type {
  ToolDescription,
  SanitizedTool,
  ToolPin,
  PinValidation,
  ShadowDetection,
} from './ToolSanitizer';

export { OutputGuard } from './OutputGuard';
export type {
  SecretScanResult,
  SecretMatch,
  SecretType,
  ExfiltrationResult,
} from './OutputGuard';

export { LLMResponseGuard } from './LLMResponseGuard';
export type {
  LLMResponseValidation,
  ResponseViolation,
  ResponseViolationType,
  ToolCallProposal,
  GuardConfig,
} from './LLMResponseGuard';

export { SupplyChainGuard } from './SupplyChainGuard';
export type {
  SupplyChainCheckResult,
  SupplyChainIssue,
  SupplyChainIssueType,
} from './SupplyChainGuard';
