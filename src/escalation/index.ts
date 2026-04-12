/**
 * @packageDocumentation
 * @module Escalation
 * @description
 * Human-in-the-loop escalation and circuit breaker for agent safety.
 */

export { EscalationManager } from './EscalationManager';
export type {
  EscalationTicket,
  EscalationStatus,
  EscalationEvent,
  EscalationListener,
} from './EscalationManager';

export { CircuitBreaker } from './CircuitBreaker';
export type {
  CircuitBreakerState,
  CircuitBreakerStatus,
  CircuitBreakerEvent,
  CircuitBreakerListener,
} from './CircuitBreaker';
