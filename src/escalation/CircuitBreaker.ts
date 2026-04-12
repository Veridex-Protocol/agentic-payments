/**
 * @packageDocumentation
 * @module CircuitBreaker
 * @description
 * Implements the circuit breaker pattern for agent safety.
 *
 * States:
 * - **closed**: Normal operation. Actions flow through.
 * - **open**: Tripped. All actions are blocked until manual reset.
 * - **half-open**: Cautious. Limited actions allowed to test recovery.
 *
 * The breaker auto-trips on:
 * - N consecutive blocks from the policy engine
 * - Injection detection (if configured)
 * - Critical anomaly detection (if configured)
 *
 * Only a human `reset()` call can transition from `open` to `half-open`.
 */

import type { CircuitBreakerConfig } from '../policy/types';

// ── Types ──

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  consecutiveBlocks: number;
  lastTrippedAt?: number;
  lastResetAt?: number;
  halfOpenAttempts: number;
  tripReason?: string;
}

export type CircuitBreakerEvent = 'tripped' | 'reset' | 'half-open' | 'closed';
export type CircuitBreakerListener = (status: CircuitBreakerStatus) => void;

// ── Default Config ──

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  consecutiveBlocksToTrip: 3,
  halfOpenMaxAttempts: 2,
  cooldownMs: 5 * 60 * 1000, // 5 minutes
  tripOnInjection: true,
  tripOnAnomaly: false,
};

// ── Implementation ──

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private consecutiveBlocks = 0;
  private halfOpenAttempts = 0;
  private lastTrippedAt?: number;
  private lastResetAt?: number;
  private tripReason?: string;
  private config: CircuitBreakerConfig;
  private listeners: Map<CircuitBreakerEvent, Set<CircuitBreakerListener>> = new Map();

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if the circuit breaker allows an action.
   * Returns true if the action can proceed.
   */
  allowAction(): boolean {
    switch (this.state) {
      case 'closed':
        return true;
      case 'open':
        return false;
      case 'half-open':
        return this.halfOpenAttempts < this.config.halfOpenMaxAttempts;
    }
  }

  /**
   * Record a successful action (resets consecutive block count).
   * In half-open state, successful actions transition to closed.
   */
  recordSuccess(): void {
    this.consecutiveBlocks = 0;

    if (this.state === 'half-open') {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
        this.state = 'closed';
        this.halfOpenAttempts = 0;
        this.emit('closed');
      }
    }
  }

  /**
   * Record a blocked action. Increments the consecutive block counter.
   * If the threshold is reached, the breaker trips.
   */
  recordBlock(reason?: string): void {
    this.consecutiveBlocks++;

    if (this.state === 'half-open') {
      // Any block in half-open immediately re-opens
      this.trip(reason ?? 'Block during half-open recovery');
      return;
    }

    if (this.consecutiveBlocks >= this.config.consecutiveBlocksToTrip) {
      this.trip(reason ?? `${this.consecutiveBlocks} consecutive blocks`);
    }
  }

  /**
   * Record an injection detection. Trips immediately if configured.
   */
  recordInjection(details?: string): void {
    if (this.config.tripOnInjection) {
      this.trip(`Injection detected: ${details ?? 'unknown'}`);
    }
  }

  /**
   * Record a critical anomaly. Trips immediately if configured.
   */
  recordAnomaly(details?: string): void {
    if (this.config.tripOnAnomaly) {
      this.trip(`Critical anomaly: ${details ?? 'unknown'}`);
    }
  }

  /**
   * Trip the circuit breaker. Transitions to `open` state.
   */
  trip(reason: string): void {
    this.state = 'open';
    this.lastTrippedAt = Date.now();
    this.tripReason = reason;
    this.halfOpenAttempts = 0;
    this.emit('tripped');
  }

  /**
   * Human-initiated reset. Transitions from `open` to `half-open`.
   * Only works when the breaker is open and cooldown has elapsed.
   */
  reset(): boolean {
    if (this.state !== 'open') return false;

    const elapsed = Date.now() - (this.lastTrippedAt ?? 0);
    if (elapsed < this.config.cooldownMs) return false;

    this.state = 'half-open';
    this.halfOpenAttempts = 0;
    this.consecutiveBlocks = 0;
    this.lastResetAt = Date.now();
    this.emit('half-open');
    return true;
  }

  /**
   * Force reset (emergency). Transitions directly to `closed`.
   * Use with caution — bypasses cooldown.
   */
  forceReset(): void {
    this.state = 'closed';
    this.consecutiveBlocks = 0;
    this.halfOpenAttempts = 0;
    this.lastResetAt = Date.now();
    this.tripReason = undefined;
    this.emit('reset');
  }

  /**
   * Get the current status of the circuit breaker.
   */
  getStatus(): CircuitBreakerStatus {
    return {
      state: this.state,
      consecutiveBlocks: this.consecutiveBlocks,
      lastTrippedAt: this.lastTrippedAt,
      lastResetAt: this.lastResetAt,
      halfOpenAttempts: this.halfOpenAttempts,
      tripReason: this.tripReason,
    };
  }

  /**
   * Register an event listener.
   */
  on(event: CircuitBreakerEvent, listener: CircuitBreakerListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  /**
   * Remove an event listener.
   */
  off(event: CircuitBreakerEvent, listener: CircuitBreakerListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: CircuitBreakerEvent): void {
    const status = this.getStatus();
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(status);
        } catch {
          // Listener errors are non-fatal
        }
      }
    }
  }
}
