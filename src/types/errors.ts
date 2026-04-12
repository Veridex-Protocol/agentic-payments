/**
 * @packageDocumentation
 * @module AgentErrors
 * @description
 * Standardized error handling for the Agent SDK.
 * 
 * Provides typed error codes and actionable remediation steps for common
 * failure scenarios (e.g., Session Expired, Limit Exceeded, Network Error).
 */
export enum AgentPaymentErrorCode {
    // Session errors (1xxx)
    SESSION_EXPIRED = 1001,
    SESSION_REVOKED = 1002,
    SESSION_INVALID = 1003,

    // Limit errors (2xxx)
    LIMIT_EXCEEDED = 2001,
    DAILY_LIMIT_EXCEEDED = 2002,
    TRANSACTION_LIMIT_EXCEEDED = 2003,

    // Balance errors (3xxx)
    INSUFFICIENT_BALANCE = 3001,
    INSUFFICIENT_BALANCE_ALL_CHAINS = 3002,

    // Payment errors (4xxx)
    PAYMENT_FAILED = 4001,
    PAYMENT_TIMEOUT = 4002,
    INVALID_RECIPIENT = 4003,
    INVALID_AMOUNT = 4004,

    // Network errors (5xxx)
    NETWORK_ERROR = 5001,
    RPC_ERROR = 5002,
    RELAYER_ERROR = 5003,

    // Protocol errors (6xxx)
    X402_PARSE_ERROR = 6001,
    UCP_NEGOTIATION_FAILED = 6002,
    MCP_VALIDATION_ERROR = 6003,
    ACP_CHECKOUT_FAILED = 6004,
    AP2_MANDATE_FAILED = 6005,
    PROTOCOL_NOT_SUPPORTED = 6006,
    PROTOCOL_DETECTION_FAILED = 6007,
    PAYMENT_NOT_APPROVED = 6008,

    // Token errors (7xxx)
    TOKEN_EXPIRED = 7001,
    TOKEN_INVALID = 7002,
    TOKEN_REVOKED = 7003,
    TOKEN_NOT_SUPPORTED = 7004,

    // Chain errors (8xxx)
    CHAIN_NOT_SUPPORTED = 8001,

    // Agent-Safe Execution Control Plane errors (9xxx)
    POLICY_VIOLATION = 9001,
    ESCALATION_REQUIRED = 9002,
    CIRCUIT_BREAKER_OPEN = 9003,
    INJECTION_DETECTED = 9004,
    TRACE_COMMITMENT_FAILED = 9005,
}

export class AgentPaymentError extends Error {
    public code: AgentPaymentErrorCode;
    public remediation: string;
    public retryable: boolean;
    public context?: Record<string, any>;

    constructor(
        code: AgentPaymentErrorCode,
        message: string,
        remediation: string,
        retryable: boolean = false,
        context?: Record<string, any>
    ) {
        super(message);
        this.name = 'AgentPaymentError';
        this.code = code;
        this.remediation = remediation;
        this.retryable = retryable;
        this.context = context;

        // Ensure proper prototype chain for inheritance
        Object.setPrototypeOf(this, AgentPaymentError.prototype);
    }

    static fromLimitExceeded(reason: string, context?: Record<string, any>): AgentPaymentError {
        return new AgentPaymentError(
            AgentPaymentErrorCode.LIMIT_EXCEEDED,
            `Spending limit exceeded: ${reason}`,
            'Wait for the daily limit to reset or increase your session budget using your master passkey.',
            false,
            context
        );
    }

    static fromSessionExpired(context?: Record<string, any>): AgentPaymentError {
        return new AgentPaymentError(
            AgentPaymentErrorCode.SESSION_EXPIRED,
            'Your agent session has expired.',
            'Create a new session using your master passkey to continue.',
            false,
            context
        );
    }

    static fromNetworkError(message: string, context?: Record<string, any>): AgentPaymentError {
        return new AgentPaymentError(
            AgentPaymentErrorCode.NETWORK_ERROR,
            `Network error: ${message}`,
            'Check your connectivity and try again. The SDK will automatically retry transient failures.',
            true,
            context
        );
    }

    static fromPolicyViolation(reasons: string[], context?: Record<string, any>): AgentPaymentError {
        return new AgentPaymentError(
            AgentPaymentErrorCode.POLICY_VIOLATION,
            `Policy violation: ${reasons.join('; ')}`,
            'The action was blocked by the policy engine. Review the mandate configuration.',
            false,
            context
        );
    }

    static fromEscalationRequired(ticketId: string, reasons: string[], context?: Record<string, any>): AgentPaymentError {
        return new AgentPaymentError(
            AgentPaymentErrorCode.ESCALATION_REQUIRED,
            `Escalation required (ticket: ${ticketId}): ${reasons.join('; ')}`,
            `Approve or reject escalation ticket '${ticketId}' via getEscalationManager().approve/reject().`,
            false,
            { ...context, ticketId }
        );
    }

    static fromCircuitBreakerOpen(state: string, reason?: string, context?: Record<string, any>): AgentPaymentError {
        return new AgentPaymentError(
            AgentPaymentErrorCode.CIRCUIT_BREAKER_OPEN,
            `Circuit breaker is ${state}: ${reason ?? 'safety threshold exceeded'}`,
            'The circuit breaker has tripped due to repeated policy violations. A human must call reset() after the cooldown period.',
            false,
            { ...context, circuitBreakerState: state, tripReason: reason }
        );
    }

    static fromInjectionDetected(details: string, context?: Record<string, any>): AgentPaymentError {
        return new AgentPaymentError(
            AgentPaymentErrorCode.INJECTION_DETECTED,
            `Injection detected: ${details}`,
            'A prompt injection attack was detected and blocked. Review the input for malicious content.',
            false,
            context
        );
    }

    static fromTraceCommitmentFailed(reason: string, context?: Record<string, any>): AgentPaymentError {
        return new AgentPaymentError(
            AgentPaymentErrorCode.TRACE_COMMITMENT_FAILED,
            `Trace commitment failed: ${reason}`,
            'The trace could not be signed or stored. Check the trace storage adapter configuration.',
            true,
            context
        );
    }

    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            remediation: this.remediation,
            retryable: this.retryable,
            context: this.context,
        };
    }
}
