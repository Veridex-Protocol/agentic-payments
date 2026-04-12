/**
 * @packageDocumentation
 * @module EscalationManager
 * @description
 * Manages human-in-the-loop escalation for actions that require approval.
 * When the policy engine returns an `escalate` verdict, the EscalationManager
 * creates a ticket that must be approved or rejected before the action proceeds.
 *
 * Features:
 * - Ticket lifecycle: created → approved/rejected/timeout
 * - Event emitter pattern for real-time notifications
 * - Configurable timeout with auto-reject
 */

import type { VerdictResult, ProposedAction } from '../policy/types';

// ── Types ──

export type EscalationStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

export interface EscalationTicket {
  /** Unique ticket identifier */
  id: string;
  /** The proposed action awaiting approval */
  action: ProposedAction;
  /** The verdict that triggered escalation */
  verdict: VerdictResult;
  /** Current ticket status */
  status: EscalationStatus;
  /** When the ticket was created */
  createdAt: number;
  /** When the ticket was resolved */
  resolvedAt?: number;
  /** Who approved/rejected (address or identifier) */
  resolvedBy?: string;
  /** Rejection reason */
  rejectionReason?: string;
  /** Timeout deadline (ms since epoch) */
  timeoutAt: number;
}

export type EscalationEvent = 'escalated' | 'approved' | 'rejected' | 'timeout';
export type EscalationListener = (ticket: EscalationTicket) => void;

// ── Implementation ──

export class EscalationManager {
  private tickets: Map<string, EscalationTicket> = new Map();
  private listeners: Map<EscalationEvent, Set<EscalationListener>> = new Map();
  private timeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = 5 * 60 * 1000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Create an escalation ticket for a proposed action.
   * Starts the timeout countdown.
   */
  escalate(
    action: ProposedAction,
    verdict: VerdictResult,
    timeoutMs?: number
  ): EscalationTicket {
    const id = this.generateId();
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    const ticket: EscalationTicket = {
      id,
      action,
      verdict,
      status: 'pending',
      createdAt: Date.now(),
      timeoutAt: Date.now() + timeout,
    };

    this.tickets.set(id, ticket);

    // Set timeout for auto-reject
    const timer = setTimeout(() => {
      this.handleTimeout(id);
    }, timeout);
    this.timeouts.set(id, timer);

    this.emit('escalated', ticket);
    return ticket;
  }

  /**
   * Approve an escalation ticket.
   */
  approve(ticketId: string, approver: string): EscalationTicket {
    const ticket = this.getTicketOrThrow(ticketId);

    if (ticket.status !== 'pending') {
      throw new Error(`Ticket ${ticketId} is already ${ticket.status}`);
    }

    ticket.status = 'approved';
    ticket.resolvedAt = Date.now();
    ticket.resolvedBy = approver;
    this.clearTimeout(ticketId);
    this.emit('approved', ticket);

    return ticket;
  }

  /**
   * Reject an escalation ticket.
   */
  reject(ticketId: string, approver: string, reason?: string): EscalationTicket {
    const ticket = this.getTicketOrThrow(ticketId);

    if (ticket.status !== 'pending') {
      throw new Error(`Ticket ${ticketId} is already ${ticket.status}`);
    }

    ticket.status = 'rejected';
    ticket.resolvedAt = Date.now();
    ticket.resolvedBy = approver;
    ticket.rejectionReason = reason;
    this.clearTimeout(ticketId);
    this.emit('rejected', ticket);

    return ticket;
  }

  /**
   * Get a ticket by ID.
   */
  getTicket(ticketId: string): EscalationTicket | undefined {
    return this.tickets.get(ticketId);
  }

  /**
   * Get all pending tickets.
   */
  getPendingTickets(): EscalationTicket[] {
    return Array.from(this.tickets.values()).filter((t) => t.status === 'pending');
  }

  /**
   * Register an event listener.
   */
  on(event: EscalationEvent, listener: EscalationListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  /**
   * Remove an event listener.
   */
  off(event: EscalationEvent, listener: EscalationListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  /**
   * Clean up all pending timeouts. Call this on shutdown.
   */
  dispose(): void {
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
  }

  private handleTimeout(ticketId: string): void {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.status !== 'pending') return;

    ticket.status = 'timeout';
    ticket.resolvedAt = Date.now();
    this.timeouts.delete(ticketId);
    this.emit('timeout', ticket);
  }

  private getTicketOrThrow(ticketId: string): EscalationTicket {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Escalation ticket ${ticketId} not found`);
    }
    return ticket;
  }

  private clearTimeout(ticketId: string): void {
    const timer = this.timeouts.get(ticketId);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(ticketId);
    }
  }

  private emit(event: EscalationEvent, ticket: EscalationTicket): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(ticket);
        } catch {
          // Listener errors are non-fatal
        }
      }
    }
  }

  private generateId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `esc-${crypto.randomUUID()}`;
    }
    return `esc-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
