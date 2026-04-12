/**
 * @packageDocumentation
 * @module AgentWallet
 * @description
 * The core orchestration class for the Veridex Agent SDK.
 *
 * The AgentWallet serves as the central hub for all agentic payment operations, coordinating
 * session management, x402 protocol negotiation, UCP credential issuance, and multi-chain execution.
 *
 * Key Features:
 * - **Session Management**: Automatically handles session key lifecycle, spending limits, and expiration.
 * - **x402 Client**: Intercepts HTTP 402 responses to perform autonomous payments.
 * - **Multi-Chain Support**: Routes transactions to appropriate chain adapters (EVM, Starknet, Solana, etc.).
 * - **Monitoring**: Provides audit logging and real-time spending alerts.
 *
 * @example
 * ```typescript
 * import { createAgentWallet } from '@veridex/agentic-payments';
 *
 * const agent = await createAgentWallet({
 *   session: { dailyLimitUSD: 100 }
 * });
 *
 * // Autonomous payment via x402
 * await agent.fetch('https://paid-resource.com');
 * ```
 */
import { VeridexSDK, TokenBalance, PortfolioBalance, createSDK, ChainName, PasskeyCredential, getEffectivePrimaryHub } from '@veridex/sdk';
import { AgentWalletConfig, PaymentParams, PaymentReceipt, SessionStatus, HistoryOptions } from './types/agent';
import { SessionKeyManager } from './session/SessionKeyManager';
import { SessionKeyConfig, StoredSession } from './session/SessionStorage';
import { X402Client } from './x402/X402Client';
import { UCPCredentialProvider } from './ucp/CredentialProvider';
import { MCPServer } from './mcp/MCPServer';
import { CrossChainRouter } from './routing/CrossChainRouter';
import { AuditLogger, PaymentRecord } from './monitoring/AuditLogger';
import { AlertManager } from './monitoring/AlertManager';
import { ComplianceExporter } from './monitoring/ComplianceExporter';
import { BalanceCache } from './monitoring/BalanceCache';
import { AgentPaymentError, AgentPaymentErrorCode } from './types/errors';
import { SpendingAlert } from './types/agent';
import { ethers } from 'ethers';
import { ProtocolDetector } from './protocols/base/ProtocolDetector';
import { X402Handler } from './protocols/x402/X402Handler';
import { UCPHandler } from './protocols/ucp/UCPHandler';
import { ACPHandler } from './protocols/acp/ACPHandler';
import { AP2Handler } from './protocols/ap2/AP2Handler';
import { MPPHandler } from './protocols/mpp/MPPHandler';
import { UniversalFetchOptions, ProtocolContext, ProtocolName, CostEstimate, DetectionResult } from './protocols/base/types';
import { PolicyEngine } from './policy/PolicyEngine';
import type { Mandate, ProposedAction, EvaluationContext, VerdictResult } from './policy/types';
import { AssetWhitelistRule } from './policy/rules/AssetWhitelistRule';
import { ChainWhitelistRule } from './policy/rules/ChainWhitelistRule';
import { ProtocolWhitelistRule } from './policy/rules/ProtocolWhitelistRule';
import { SpendingLimitRule } from './policy/rules/SpendingLimitRule';
import { CounterpartyRule } from './policy/rules/CounterpartyRule';
import { TimeWindowRule } from './policy/rules/TimeWindowRule';
import { VelocityRule } from './policy/rules/VelocityRule';
import { HumanApprovalRule } from './policy/rules/HumanApprovalRule';
import { TraceInterceptor } from './trace/TraceInterceptor';
import { EvidenceBundle } from './trace/EvidenceBundle';
import type { TraceStorageAdapter, TraceResult, DisputeBundle as TracDisputeBundle } from './trace/types';
import { EscalationManager } from './escalation/EscalationManager';
import { CircuitBreaker } from './escalation/CircuitBreaker';
import { IdentityClient } from './identity/IdentityClient';
import { ReputationClient } from './identity/ReputationClient';
import { TrustGate } from './identity/TrustGate';
import { AgentDiscovery } from './identity/AgentDiscovery';
import { RegistrationFileManager } from './identity/RegistrationFileManager';
import type {
  AgentRegistration,
  RegisterAgentOptions,
  FeedbackOptions,
  FeedbackSummary,
  ERC8004Config,
  TrustCheckResult,
  DiscoveryQuery,
  ResolvedAgent,
} from './identity/types';

export class AgentWallet {
  private sessionManager: SessionKeyManager;
  private x402Client: X402Client;
  private ucpProvider: UCPCredentialProvider;
  private mcpServer?: MCPServer;
  private router: CrossChainRouter;
  private auditLogger: AuditLogger;
  private alertManager: AlertManager;
  private complianceExporter: ComplianceExporter;
  private balanceCache: BalanceCache;
  private coreSDK!: VeridexSDK;
  private currentSession?: StoredSession;
  private protocolDetector: ProtocolDetector;
  private anomalyDetector?: import('./security/AnomalyDetector').AnomalyDetector;

  // ERC-8004 Identity & Reputation (ADR-0029)
  private identityClient?: IdentityClient;
  private reputationClient?: ReputationClient;
  private trustGate?: TrustGate;
  private agentDiscovery?: AgentDiscovery;
  private _agentId?: bigint;
  private erc8004Config?: ERC8004Config;

  // Agent-Safe Execution Control Plane
  private policyEngine?: PolicyEngine;
  private _lastVerdict?: VerdictResult;
  private traceInterceptor?: TraceInterceptor;
  private evidenceBundle?: EvidenceBundle;
  private _lastTrace?: TraceResult;
  private escalationManager?: EscalationManager;
  private circuitBreaker?: CircuitBreaker;

  constructor(private config: AgentWalletConfig) {
    this.sessionManager = new SessionKeyManager();
    // coreSDK will be initialized in init() or first use
    this.ucpProvider = new UCPCredentialProvider(this.sessionManager);
    this.router = new CrossChainRouter();
    this.auditLogger = new AuditLogger();
    this.alertManager = new AlertManager();
    this.complianceExporter = new ComplianceExporter();
    this.balanceCache = new BalanceCache();
    // x402Client needs coreSDK, so we'll lazy-init it
    this.x402Client = new X402Client(this.sessionManager, null as any, config.x402);

    if (config.mcp?.enabled) {
      this.mcpServer = new MCPServer(this);
    }

    // Initialize Universal Protocol Abstraction Layer
    this.protocolDetector = new ProtocolDetector();
    this.protocolDetector.registerHandlers([
      new UCPHandler(),   // Priority: 100
      new ACPHandler(),   // Priority: 90
      new MPPHandler(),   // Priority: 85
      new AP2Handler(),   // Priority: 80
      new X402Handler(),  // Priority: 70
    ]);

    // Initialize Anomaly Detector (unified batch + streaming fingerprint)
    try {
      const { AnomalyDetector } = require('./security/AnomalyDetector');
      this.anomalyDetector = new AnomalyDetector();
    } catch {
      // Optional — anomaly detection degrades gracefully
    }

    // Initialize ERC-8004 if configured
    this.erc8004Config = (config as any).erc8004;

    // Initialize Policy Engine if mandate is configured (Agent-Safe Execution Control Plane)
    if (config.mandate) {
      this.policyEngine = new PolicyEngine(config.mandate);
      // Register built-in rules
      this.policyEngine.addRule(new AssetWhitelistRule());
      this.policyEngine.addRule(new ChainWhitelistRule());
      this.policyEngine.addRule(new ProtocolWhitelistRule());
      this.policyEngine.addRule(new CounterpartyRule());
      this.policyEngine.addRule(new TimeWindowRule());
      this.policyEngine.addRule(new SpendingLimitRule(config.mandate.limits));
      this.policyEngine.addRule(new VelocityRule());
      this.policyEngine.addRule(new HumanApprovalRule({
        amountUSDThreshold: config.mandate.escalation.amountUSDThreshold,
        riskScoreThreshold: config.mandate.escalation.riskScoreThreshold,
      }));

      // Initialize EscalationManager with timeout from mandate
      this.escalationManager = new EscalationManager(
        config.mandate.escalation.timeoutMs
      );

      // Initialize CircuitBreaker with config from mandate
      this.circuitBreaker = new CircuitBreaker(config.mandate.circuitBreaker);
    }

    // Initialize Trace Interceptor if traceStorage is configured
    if (config.traceStorage) {
      this.traceInterceptor = new TraceInterceptor(config.traceStorage);
      this.evidenceBundle = new EvidenceBundle(this.traceInterceptor);
    }
  }

  async init(): Promise<void> {
    // Use the effective primary hub from feature flags (defaults to 'base' when multi-hub disabled)
    const hubChain = getEffectivePrimaryHub();
    this.coreSDK = createSDK(hubChain, {
      relayerUrl: this.config.relayerUrl,
      relayerApiKey: this.config.relayerApiKey,
    });

    // Update x402Client with initialized coreSDK
    (this.x402Client as any).coreSDK = this.coreSDK;

    this.currentSession = await this.restoreLatestSession();

    if (!this.currentSession) {
      this.currentSession = await this.createSession(
        {
          dailyLimitUSD: this.config.session.dailyLimitUSD,
          perTransactionLimitUSD: this.config.session.perTransactionLimitUSD,
          expiryTimestamp: Date.now() + (this.config.session.expiryHours * 60 * 60 * 1000),
          allowedChains: this.config.session.allowedChains,
        },
        { setActive: true }
      );
    }

    // Initialize ERC-8004 clients if enabled
    if (this.erc8004Config?.enabled) {
      await this.initERC8004();
    }
  }

  private async restoreLatestSession(): Promise<StoredSession | undefined> {
    const sessions = await this.sessionManager.getSessionsForMasterKey(
      this.config.masterCredential.keyHash
    );

    if (sessions.length === 0) {
      return undefined;
    }

    return sessions.sort(
      (left, right) =>
        (right.metadata.lastUsedAt || right.metadata.createdAt) -
        (left.metadata.lastUsedAt || left.metadata.createdAt)
    )[0];
  }

  /**
   * Initialize ERC-8004 identity and reputation clients.
   */
  private async initERC8004(): Promise<void> {
    const provider = this.erc8004Config?.registryProvider ||
      new ethers.JsonRpcProvider('https://mainnet.base.org');

    const signer = this.currentSession
      ? await this.sessionManager.getSessionWallet(
          this.currentSession,
          this.config.masterCredential.credentialId
        )
      : undefined;

    const config = { testnet: this.erc8004Config?.testnet ?? false };

    this.identityClient = new IdentityClient(provider, signer, config);
    this.reputationClient = new ReputationClient(provider, signer, config);

    if (this.erc8004Config?.minReputationScore && this.erc8004Config.minReputationScore > 0) {
      this.trustGate = new TrustGate(this.reputationClient, this.identityClient, {
        minReputation: this.erc8004Config.minReputationScore,
        trustedReviewers: this.erc8004Config.trustedReviewers,
        trustModel: 'reputation',
        mode: 'reject',
      });
    }

    this.agentDiscovery = new AgentDiscovery(
      this.identityClient,
      this.reputationClient,
    );

    // Restore pre-registered agentId if provided
    if (this.erc8004Config?.agentId) {
      this._agentId = this.erc8004Config.agentId;
    }
  }

  /**
 * Create a new session key with specific config
 */
  async createSession(
    config: SessionKeyConfig,
    options?: { setActive?: boolean }
  ): Promise<StoredSession> {
    const session = await this.sessionManager.createSession(this.config.masterCredential, config);

    if (options?.setActive ?? true) {
      this.currentSession = session;
    }

    return session;
  }

  async listSessions(): Promise<StoredSession[]> {
    return this.sessionManager.getSessionsForMasterKey(this.config.masterCredential.keyHash);
  }

  async selectSession(keyHash: string): Promise<StoredSession> {
    const session = await this.sessionManager.loadSession(keyHash);

    if (!session || session.masterKeyHash !== this.config.masterCredential.keyHash) {
      throw new Error(`Session ${keyHash} not found`);
    }

    this.currentSession = session;
    return session;
  }

  /**
   * Universal fetch — auto-detects payment protocol and handles it transparently.
   * This is the primary API for agent HTTP requests (ADR-0025).
   *
   * Supports: x402, UCP, ACP, AP2 with automatic detection.
   * Falls back to the legacy X402Client for backward compatibility.
   *
   * @param url - Request URL
   * @param options - Extended fetch options with protocol hints and callbacks
   * @returns Response from the server (after payment if needed)
   *
   * @example
   * ```typescript
   * // Automatic protocol detection (recommended)
   * const response = await agent.fetch('https://any-merchant.com/api');
   *
   * // Force a specific protocol
   * const response = await agent.fetch('https://merchant.com/api', { protocol: 'ucp' });
   *
   * // With payment approval callback
   * const response = await agent.fetch('https://merchant.com/api', {
   *   onBeforePayment: async (estimate) => {
   *     console.log(`About to pay $${estimate.amountUSD}`);
   *     return estimate.amountUSD < 10; // auto-approve under $10
   *   }
   * });
   * ```
   */
  async fetch(url: string, options?: UniversalFetchOptions): Promise<Response> {
    if (!this.currentSession) await this.init();

    return await this.withRetry(async () => {
      const fetchOptions: RequestInit = { ...options };
      const timeoutMs = options?.timeoutMs ?? 30000;

      // Make initial request
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let initialResponse: Response;

      try {
        initialResponse = await globalThis.fetch(url, {
          ...fetchOptions,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      // If no payment required, return immediately
      if (initialResponse.status !== 402 && !this.hasProtocolHeaders(initialResponse)) {
        return initialResponse;
      }

      // Decrypt session key once and pass the wallet to handlers
      const signerWallet = await this.sessionManager.getSessionWallet(
        this.currentSession!,
        this.config.masterCredential.credentialId
      );

      // Build protocol context
      const context: ProtocolContext = {
        session: this.currentSession!,
        signerWallet,
        relayerUrl: this.config.relayerUrl,
        relayerApiKey: this.config.relayerApiKey,
      };

      // Detect or force protocol
      let handler;
      if (options?.protocol) {
        handler = this.protocolDetector.getHandler(options.protocol);
        if (!handler) {
          throw new AgentPaymentError(
            AgentPaymentErrorCode.PAYMENT_FAILED,
            `Forced protocol '${options.protocol}' is not registered`,
            'Use a supported protocol: x402, ucp, acp, ap2',
            false
          );
        }
      } else {
        handler = await this.protocolDetector.detect(
          initialResponse,
          url,
          options?.allowedProtocols
        );
      }

      // Fallback to legacy X402Client if no handler matched but status is 402
      if (!handler && initialResponse.status === 402) {
        return await this.x402Client.handleFetch(url, fetchOptions, this.currentSession!);
      }

      if (!handler) {
        return initialResponse; // No payment protocol detected
      }

      // Notify detection callback
      options?.onProtocolDetected?.({
        protocol: handler.protocolName,
        confidence: 1.0,
        metadata: { url, status: initialResponse.status },
      });

      // Cost estimation + approval callback
      if (!options?.skipEstimate && options?.onBeforePayment) {
        const estimate = await handler.estimateCost(initialResponse);
        const approved = await options.onBeforePayment(estimate);
        if (!approved) {
          throw new AgentPaymentError(
            AgentPaymentErrorCode.PAYMENT_FAILED,
            'Payment was not approved by onBeforePayment callback',
            'The payment was rejected by the application logic.',
            false
          );
        }
      }

      // Auto-approve limit check
      if (options?.maxAutoApproveUSD !== undefined) {
        const estimate = await handler.estimateCost(initialResponse);
        if (estimate.amountUSD > options.maxAutoApproveUSD) {
          throw AgentPaymentError.fromLimitExceeded(
            `Payment $${estimate.amountUSD.toFixed(2)} exceeds auto-approve limit $${options.maxAutoApproveUSD}`,
            { amountUSD: estimate.amountUSD, maxAutoApproveUSD: options.maxAutoApproveUSD }
          );
        }
      }

      // ── Circuit Breaker Check ──
      if (this.circuitBreaker && !this.circuitBreaker.allowAction()) {
        const status = this.circuitBreaker.getStatus();
        throw new AgentPaymentError(
          AgentPaymentErrorCode.PAYMENT_NOT_APPROVED,
          `Circuit breaker is ${status.state}: ${status.tripReason ?? 'safety threshold exceeded'}`,
          'The circuit breaker has tripped due to repeated policy violations. A human must call reset() after the cooldown period.',
          false,
          { circuitBreakerState: status.state, tripReason: status.tripReason, lastTrippedAt: status.lastTrippedAt }
        );
      }

      // ── Policy Engine Evaluation (Agent-Safe Execution Control Plane) ──
      if (this.policyEngine) {
        const estimate = await handler.estimateCost(initialResponse);
        const proposedAction: ProposedAction = {
          type: 'payment',
          recipient: url,
          asset: estimate.token,
          amount: estimate.amountRaw,
          amountUSD: estimate.amountUSD,
          chain: typeof estimate.chain === 'number' ? estimate.chain : 0,
          protocol: handler.protocolName,
          metadata: { url, scheme: estimate.scheme },
        };

        const evalCtx: EvaluationContext = {
          action: proposedAction,
          session: this.currentSession!,
          mandate: this.policyEngine.getMandate(),
          timestamp: Date.now(),
        };

        const verdict = await this.policyEngine.evaluate(evalCtx);
        this._lastVerdict = verdict;

        if (verdict.verdict === 'block') {
          this.circuitBreaker?.recordBlock(verdict.reasons.join('; '));
          throw new AgentPaymentError(
            AgentPaymentErrorCode.PAYMENT_NOT_APPROVED,
            `Policy violation: ${verdict.reasons.join('; ')}`,
            'The action was blocked by the policy engine. Review the mandate configuration.',
            false,
            { verdict: verdict.verdict, riskScore: verdict.riskScore, checks: verdict.checks }
          );
        }

        if (verdict.verdict === 'escalate') {
          // Try inline callback first (simple use-case)
          const onEscalation = (options as any)?.onEscalation as
            | ((verdict: VerdictResult) => Promise<boolean>)
            | undefined;
          if (onEscalation) {
            const approved = await onEscalation(verdict);
            if (!approved) {
              this.circuitBreaker?.recordBlock('Escalation rejected by callback');
              throw new AgentPaymentError(
                AgentPaymentErrorCode.PAYMENT_NOT_APPROVED,
                `Escalation rejected: ${verdict.reasons.join('; ')}`,
                'The action required human approval which was denied.',
                false,
                { verdict: verdict.verdict, riskScore: verdict.riskScore, escalationTrigger: verdict.escalationTrigger }
              );
            }
          } else if (this.escalationManager) {
            // Create an escalation ticket and throw — caller must approve via getEscalationManager()
            const ticket = this.escalationManager.escalate(proposedAction, verdict);
            throw new AgentPaymentError(
              AgentPaymentErrorCode.PAYMENT_NOT_APPROVED,
              `Escalation required (ticket: ${ticket.id}): ${verdict.reasons.join('; ')}`,
              `Approve or reject escalation ticket '${ticket.id}' via getEscalationManager().approve/reject().`,
              false,
              { verdict: verdict.verdict, riskScore: verdict.riskScore, escalationTrigger: verdict.escalationTrigger, ticketId: ticket.id }
            );
          } else {
            throw new AgentPaymentError(
              AgentPaymentErrorCode.PAYMENT_NOT_APPROVED,
              `Escalation required but no onEscalation handler configured: ${verdict.reasons.join('; ')}`,
              'Configure an onEscalation callback to handle actions requiring human approval.',
              false,
              { verdict: verdict.verdict, riskScore: verdict.riskScore, escalationTrigger: verdict.escalationTrigger }
            );
          }
        }

        if (verdict.verdict === 'flag') {
          console.warn('[PolicyEngine] Flag:', verdict.reasons.join('; '), `(riskScore: ${verdict.riskScore})`);
        }

        // Record success on circuit breaker (action proceeding)
        if (verdict.verdict === 'pass' || verdict.verdict === 'flag') {
          this.circuitBreaker?.recordSuccess();
        }

        // Capture trace if TraceInterceptor is configured
        if (this.traceInterceptor) {
          const traceResult = await this.traceInterceptor.capture({
            sessionKeyHash: this.currentSession!.keyHash,
            reasoning: { toolCalls: [] },
            proposedAction,
            policyEvaluation: verdict,
          });
          this._lastTrace = traceResult;

          // Sign and store the trace
          try {
            traceResult.signature = await this.traceInterceptor.sign(
              traceResult.traceHash,
              signerWallet
            );
            await this.traceInterceptor.store(traceResult.trace, traceResult.traceHash);
          } catch {
            // Non-fatal: trace storage failure shouldn't block payment
          }
        }
      }

      // Execute protocol handler
      const response = await handler.handle(url, fetchOptions, context, initialResponse);

      // Record spending
      try {
        const estimate = await handler.estimateCost(initialResponse);
        if (estimate.amountUSD > 0) {
          await this.sessionManager.recordSpending(this.currentSession!, estimate.amountUSD);
          this.alertManager.checkSpending(
            this.currentSession!.keyHash,
            this.currentSession!.metadata.dailySpentUSD,
            this.currentSession!.config.dailyLimitUSD
          );
        }
      } catch {
        // Non-fatal: spending recording failure shouldn't block the response
      }

      // Notify settlement callback
      options?.onAfterPayment?.({
        success: response.ok,
        protocol: handler.protocolName,
        network: 'auto',
        amount: '0',
        token: 'auto',
        settledAt: Date.now(),
      });

      return response;
    });
  }

  /**
   * Check if a response contains protocol-specific headers (beyond just 402 status).
   */
  private hasProtocolHeaders(response: Response): boolean {
    return (
      response.headers.has('x-ucp-initiation-url') ||
      response.headers.has('link') && (response.headers.get('link')?.includes('ucp-manifest') ?? false) ||
      response.headers.has('openai-acp-version') ||
      response.headers.has('x-acp-checkout-url') ||
      response.headers.has('x-ap2-mandate-url') ||
      response.headers.has('x-google-a2a-mandate') ||
      (response.headers.has('www-authenticate') && (response.headers.get('www-authenticate')?.toLowerCase().startsWith('payment') ?? false))
    );
  }

  /**
   * Get the protocol detector for advanced usage (registering custom handlers, etc.).
   */
  getProtocolDetector(): ProtocolDetector {
    return this.protocolDetector;
  }

  /**
   * Get the policy engine (if mandate was configured).
   */
  getPolicyEngine(): PolicyEngine | undefined {
    return this.policyEngine;
  }

  /**
   * Get the result of the last policy evaluation.
   */
  getLastVerdict(): VerdictResult | undefined {
    return this._lastVerdict;
  }

  /**
   * Get the trace interceptor (if configured).
   */
  getTraceInterceptor(): TraceInterceptor | undefined {
    return this.traceInterceptor;
  }

  /**
   * Get the last captured trace result.
   */
  getLastTrace(): TraceResult | undefined {
    return this._lastTrace;
  }

  /**
   * Get the escalation manager (if mandate was configured).
   */
  getEscalationManager(): EscalationManager | undefined {
    return this.escalationManager;
  }

  /**
   * Get the circuit breaker (if mandate was configured).
   */
  getCircuitBreaker(): CircuitBreaker | undefined {
    return this.circuitBreaker;
  }

  /**
   * Estimate the cost of a request without executing payment.
   */
  async estimateCost(url: string, options?: RequestInit): Promise<CostEstimate | null> {
    if (!this.currentSession) await this.init();

    const response = await globalThis.fetch(url, options);
    const handler = await this.protocolDetector.detect(response, url);
    if (!handler) return null;

    return handler.estimateCost(response);
  }

  async pay(params: PaymentParams): Promise<PaymentReceipt> {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/c6390672-1465-4a0d-bb12-57e7bed0bb2e', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'AgentWallet.ts:pay:entry', message: 'pay() called', data: { params, hasSession: !!this.currentSession }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H2,H3,H4' }) }).catch(() => { });
    // #endregion

    if (!this.currentSession) await this.init();

    // Check limits
    const amountBig = BigInt(params.amount);
    let decimals = 18;
    const tokenUpper = params.token.toUpperCase();

    // Handle common stablecoins
    if (['USDC', 'USDT'].includes(tokenUpper)) {
      decimals = 6;
    }

    // Calculate estimated USD value
    // Note: For non-stablecoins, this assumes 1 Token = $1 which is inaccurate but safer than atomic units.
    // Real implementation would need a price oracle or CoinGecko API here.
    const divisor = BigInt(10) ** BigInt(decimals);
    const amountUSD = Number(amountBig) / Number(divisor);

    const limitCheck = this.sessionManager.checkLimits(this.currentSession!, amountUSD);
    if (!limitCheck.allowed) {
      throw AgentPaymentError.fromLimitExceeded(limitCheck.reason || `Transaction amount $${amountUSD.toFixed(2)} exceeds limit`);
    }

    // Get signer from session (handles encryption properly)
    const signer = await this.sessionManager.getSessionWallet(
      this.currentSession!,
      this.currentSession!.masterKeyHash || this.config.masterCredential.credentialId
    );

    // Pre-execution simulation — dry-run the tx via eth_call to catch reverts
    // before broadcasting
    if (signer.provider && params.chain !== 1) {
      try {
        const tokenAddress = await this.resolveTokenAddress(params.token, params.chain ?? 30);
        if (tokenAddress && tokenAddress !== 'native') {
          const iface = new ethers.Interface([
            'function transfer(address to, uint256 amount) returns (bool)',
          ]);
          const data = iface.encodeFunctionData('transfer', [params.recipient, amountBig]);
          await signer.provider.call({
            from: signer.address,
            to: tokenAddress,
            data,
          });
        }
      } catch (simError) {
        const simMsg = simError instanceof Error ? simError.message : String(simError);
        if (simMsg.includes('revert') || simMsg.includes('insufficient') || simMsg.includes('exceeds balance')) {
          throw AgentPaymentError.fromLimitExceeded(
            `Pre-execution simulation failed: ${simMsg}`
          );
        }
        // Non-revert errors (connection issues, etc.) — proceed to real tx
      }
    }

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/c6390672-1465-4a0d-bb12-57e7bed0bb2e', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'AgentWallet.ts:pay:beforeDirectTransfer', message: 'About to execute direct transfer', data: { signerAddress: signer.address, targetChain: params.chain, token: params.token, amount: params.amount }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H2,H4,H5' }) }).catch(() => { });
    // #endregion

    // Execute direct transfer using session wallet (bypasses passkey requirement)
    const receipt = await this.withRetry(async () => {
      return await this.executeDirectTransfer(signer, params);
    });

    // Record spending
    await this.sessionManager.recordSpending(this.currentSession!, amountUSD);

    // Behavioral fingerprinting via AnomalyDetector streaming mode
    if (this.anomalyDetector) {
      const observation = {
        amountUSD,
        recipient: params.recipient,
        chain: params.chain ?? 30,
        timestamp: Date.now(),
      };
      this.anomalyDetector.observe(this.currentSession!.keyHash, observation);
      const fpScore = this.anomalyDetector.score(this.currentSession!.keyHash, observation);
      if (fpScore.suspicious) {
        this.alertManager.checkSpending(
          this.currentSession!.keyHash,
          this.currentSession!.metadata.dailySpentUSD,
          this.currentSession!.config.dailyLimitUSD
        );
      }
    }

    // Check for alerts
    this.alertManager.checkSpending(
      this.currentSession!.keyHash,
      this.currentSession!.metadata.dailySpentUSD,
      this.currentSession!.config.dailyLimitUSD
    );

    const paymentReceipt: PaymentReceipt = {
      txHash: receipt.transactionHash,
      status: 'confirmed',
      chain: params.chain,
      token: params.token,
      amount: BigInt(params.amount),
      recipient: params.recipient,
      protocol: params.protocol || 'direct',
      timestamp: Date.now()
    };

    await this.auditLogger.log(paymentReceipt, this.currentSession!.keyHash);
    return paymentReceipt;
  }

  async getBalance(chain?: number): Promise<TokenBalance[]> {
    if (!this.coreSDK) await this.init();
    if (!this.currentSession) return [];

    const address = ethers.computeAddress(this.currentSession.publicKey);
    const targetChain = chain || 30; // Default to Base

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/c6390672-1465-4a0d-bb12-57e7bed0bb2e', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'AgentWallet.ts:getBalance', message: 'getBalance called', data: { chain, targetChain, address }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H1' }) }).catch(() => { });
    // #endregion

    // Check cache
    const cached = this.balanceCache.get(address, targetChain);
    if (cached) return cached;

    const result = await this.coreSDK.balance.getPortfolioBalance(targetChain, address);
    this.balanceCache.set(address, targetChain, result.tokens);

    return result.tokens;
  }

  async getMultiChainBalance(): Promise<PortfolioBalance> {
    if (!this.coreSDK) await this.init();
    if (!this.currentSession) throw new Error("Session not initialized");

    const address = ethers.computeAddress(this.currentSession.publicKey);
    // Preset chains to check
    const chains = [2, 30, 1, 3]; // Eth, Base, Sol, etc.
    const results = await this.coreSDK.balance.getMultiChainBalances(address, chains);

    // Aggregate results into one PortfolioBalance or return the first one?
    // The interface expects PortfolioBalance (singular). 
    // Maybe we just return the total USD value and list of all tokens?

    const combinedTokens = results.flatMap(r => r.tokens);
    const totalUsd = results.reduce((sum, r) => sum + (r.totalUsdValue || 0), 0);

    return {
      wormholeChainId: 0, // Multi-chain
      chainName: 'Multi-Chain',
      address,
      tokens: combinedTokens,
      totalUsdValue: totalUsd,
      lastUpdated: Date.now()
    };
  }

  async getPaymentHistory(options?: HistoryOptions): Promise<PaymentRecord[]> {
    return this.auditLogger.getLogs(options);
  }

  async revokeSession(keyHash?: string): Promise<void> {
    const targetKeyHash = keyHash ?? this.currentSession?.keyHash;

    if (!targetKeyHash) {
      return;
    }

    await this.sessionManager.revokeSession(targetKeyHash);

    if (this.currentSession?.keyHash === targetKeyHash) {
      this.currentSession = await this.restoreLatestSession();
    }
  }

  /**
   * Pause a session. Sets local storage pause (relay-layer circuit breaker).
   *
   * Two-layer architecture:
   *   1. LOCAL (here): Immediate — the SDK stops signing for this session.
   *   2. ON-CHAIN: VeridexHub.pauseSession() — called via user's WebAuthn
   *      passkey. Enforced at the smart contract level so even if the SDK
   *      is bypassed, the hub rejects paused sessions.
   *
   * Unlike revocation, pause is reversible via resumeSession().
   */
  async pauseSession(keyHash?: string, reason?: string): Promise<boolean> {
    const targetKeyHash = keyHash ?? this.currentSession?.keyHash;
    if (!targetKeyHash) return false;
    return this.sessionManager.pauseSession(targetKeyHash, reason);
  }

  /**
   * Resume a previously paused session.
   */
  async resumeSession(keyHash?: string): Promise<boolean> {
    const targetKeyHash = keyHash ?? this.currentSession?.keyHash;
    if (!targetKeyHash) return false;
    return this.sessionManager.resumeSession(targetKeyHash);
  }

  async getSessionStatuses(): Promise<SessionStatus[]> {
    const sessions = await this.listSessions();

    return sessions.map((session) => ({
      isValid: this.sessionManager.isSessionValid(session),
      keyHash: session.keyHash,
      expiry: session.config.expiryTimestamp,
      remainingDailyLimitUSD: session.config.dailyLimitUSD - session.metadata.dailySpentUSD,
      totalSpentUSD: session.metadata.totalSpentUSD,
      masterKeyHash: session.masterKeyHash,
      address: session.walletAddress,
      limits: {
        dailyLimitUSD: session.config.dailyLimitUSD,
        perTransactionLimitUSD: session.config.perTransactionLimitUSD,
      },
    }));
  }

  public getSessionStatus(): SessionStatus {
    if (!this.currentSession) throw new Error('No active session');
    return {
      isValid: this.sessionManager.isSessionValid(this.currentSession),
      keyHash: this.currentSession.keyHash,
      expiry: this.currentSession.config.expiryTimestamp,
      remainingDailyLimitUSD: this.currentSession.config.dailyLimitUSD - this.currentSession.metadata.dailySpentUSD,
      totalSpentUSD: this.currentSession.metadata.totalSpentUSD,
      masterKeyHash: this.currentSession.masterKeyHash,
      address: this.currentSession.walletAddress,
      limits: {
        dailyLimitUSD: this.currentSession.config.dailyLimitUSD,
        perTransactionLimitUSD: this.currentSession.config.perTransactionLimitUSD
      }
    };
  }

  async importSession(sessionData: any): Promise<void> {
    // Validate session data structure structure roughly
    if (!sessionData.keyHash || !sessionData.encryptedPrivateKey) {
      throw new Error("Invalid session data");
    }

    // Compute wallet address from publicKey if not already present
    if (!sessionData.walletAddress && sessionData.publicKey) {
      sessionData.walletAddress = ethers.computeAddress(sessionData.publicKey);
    }

    // Save to storage
    await this.sessionManager.importSession(sessionData);

    // Set as current
    this.currentSession = sessionData;
    console.log(`[AgentWallet] Imported session ${sessionData.keyHash} for master ${sessionData.masterKeyHash}`);
  }

  // Audit and monitoring
  async exportAuditLog(format: 'csv' | 'json' = 'json'): Promise<string> {
    const logs = await this.auditLogger.getLogs({ limit: 1000 }); // Export last 1000
    if (format === 'csv') {
      return this.complianceExporter.exportToCSV(logs);
    }
    return this.complianceExporter.exportToJSON(logs);
  }

  onSpendingAlert(callback: (alert: SpendingAlert) => void): void {
    this.alertManager.onAlert(callback);
  }

  getMCPTools(): any[] {
    return this.mcpServer ? this.mcpServer.getTools() : [];
  }

  // ==========================================================================
  // ERC-8004 Identity & Reputation (ADR-0029)
  // ==========================================================================

  /**
   * Register this agent on the ERC-8004 Identity Registry.
   * Mints an ERC-721 NFT representing the agent.
   *
   * @param options - Agent name, description, services, etc.
   * @returns The minted agentId and agentURI
   */
  async register(options: RegisterAgentOptions): Promise<{ agentId: bigint; agentURI: string }> {
    this.requireERC8004();
    const result = await this.identityClient!.registerWithFile(options);
    this._agentId = result.agentId;
    return result;
  }

  /**
   * Get this agent's on-chain identity.
   * Returns null if not registered.
   */
  async getIdentity(): Promise<AgentRegistration | null> {
    this.requireERC8004();
    if (!this._agentId) return null;
    try {
      return await this.identityClient!.getAgent(this._agentId);
    } catch {
      return null;
    }
  }

  /**
   * Get the agentId for this wallet (if registered).
   */
  getAgentId(): bigint | undefined {
    return this._agentId;
  }

  /**
   * Submit reputation feedback for another agent after a payment/interaction.
   *
   * @param agentId - The agent to give feedback to
   * @param options - Feedback value, tags, and optional evidence URI
   */
  async submitFeedback(agentId: bigint, options: FeedbackOptions): Promise<void> {
    this.requireERC8004();
    const tx = await this.reputationClient!.giveFeedback(agentId, options);
    await tx.wait();
  }

  /**
   * Get reputation summary for an agent.
   *
   * @param agentId - The agent to query
   * @param trustedReviewers - Optional list of trusted reviewer addresses
   */
  async getReputation(agentId: bigint, trustedReviewers?: string[]): Promise<FeedbackSummary> {
    this.requireERC8004();
    return this.reputationClient!.getSummary(agentId, trustedReviewers || []);
  }

  /**
   * Get a normalized reputation score (0-100) for an agent.
   */
  async getReputationScore(agentId: bigint, trustedReviewers?: string[]): Promise<number> {
    this.requireERC8004();
    return this.reputationClient!.getReputationScore(agentId, trustedReviewers);
  }

  /**
   * Discover agents by capability, chain, or reputation.
   */
  async discover(query: DiscoveryQuery): Promise<AgentRegistration[]> {
    this.requireERC8004();
    return this.agentDiscovery!.search(query);
  }

  /**
   * Resolve an agent from a UAI, endpoint URL, chain address, or search term.
   */
  async resolveAgent(input: string): Promise<ResolvedAgent | null> {
    this.requireERC8004();
    return this.agentDiscovery!.resolve(input);
  }

  /**
   * Check merchant trust before making a payment.
   */
  async checkMerchantTrust(endpoint: string): Promise<TrustCheckResult> {
    this.requireERC8004();
    if (!this.trustGate) {
      return { trusted: true, score: 0, reason: 'TrustGate not configured (minReputationScore=0)' };
    }
    return this.trustGate.checkMerchantTrust(endpoint);
  }

  /**
   * Get the underlying identity clients for advanced usage.
   */
  getIdentityClient(): IdentityClient | undefined {
    return this.identityClient;
  }

  getReputationClient(): ReputationClient | undefined {
    return this.reputationClient;
  }

  getAgentDiscovery(): AgentDiscovery | undefined {
    return this.agentDiscovery;
  }

  private requireERC8004(): void {
    if (!this.identityClient || !this.reputationClient) {
      throw new Error(
        'ERC-8004 not initialized. Set erc8004.enabled=true in AgentWalletConfig.'
      );
    }
  }

  /**
   * Execute a direct token transfer using the session wallet.
   * This bypasses the Veridex protocol (no passkey required) and uses the session key directly.
   */
  private async executeDirectTransfer(
    signer: ethers.Wallet,
    params: PaymentParams
  ): Promise<{ transactionHash: string }> {
    // RPC URLs for testnet chains (Wormhole Chain IDs)
    const RPC_URLS: Record<number, string> = {
      10002: 'https://ethereum-sepolia-rpc.publicnode.com',
      10003: 'https://sepolia-rollup.arbitrum.io/rpc',
      10004: 'https://sepolia.base.org',
      10005: 'https://sepolia.optimism.io',
    };

    // Token addresses for testnets (USDC)
    const USDC_ADDRESSES: Record<number, string> = {
      10002: '0x7A7754A2089df825801A0a8d95a9801928bFb22A', // Ethereum Sepolia USDC (Aave testnet USDC)
      10003: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // Arbitrum Sepolia USDC
      10004: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia USDC
      10005: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', // Optimism Sepolia USDC
    };

    const rpcUrl = RPC_URLS[params.chain];
    if (!rpcUrl) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.CHAIN_NOT_SUPPORTED,
        `Chain ${params.chain} is not supported. Use: 10002 (Eth Sepolia), 10003 (Arb Sepolia), 10004 (Base Sepolia), 10005 (Op Sepolia)`,
        'Use a supported testnet chain ID.',
        false
      );
    }

    // Connect signer to provider
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const connectedSigner = signer.connect(provider);

    const tokenUpper = params.token.toUpperCase();
    const amount = BigInt(params.amount);

    let tx: ethers.TransactionResponse;

    if (tokenUpper === 'ETH' || tokenUpper === 'NATIVE') {
      // Check ETH balance first
      const ethBalance = await provider.getBalance(signer.address);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/c6390672-1465-4a0d-bb12-57e7bed0bb2e', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'AgentWallet.ts:executeDirectTransfer:ethBalance', message: 'ETH balance check', data: { signerAddress: signer.address, ethBalance: ethBalance.toString(), requestedAmount: amount.toString() }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H6' }) }).catch(() => { });
      // #endregion

      if (ethBalance < amount) {
        throw new AgentPaymentError(
          AgentPaymentErrorCode.INSUFFICIENT_BALANCE,
          `Insufficient ETH balance: have ${ethers.formatEther(ethBalance)} ETH, need ${ethers.formatEther(amount)} ETH`,
          `Fund your wallet ${signer.address} with more ETH on chain ${params.chain}.`,
          false
        );
      }

      // Native ETH transfer
      tx = await connectedSigner.sendTransaction({
        to: params.recipient,
        value: amount,
      });
    } else if (tokenUpper === 'USDC') {
      // ERC20 transfer
      const tokenAddress = USDC_ADDRESSES[params.chain];
      if (!tokenAddress) {
        throw new AgentPaymentError(
          AgentPaymentErrorCode.TOKEN_NOT_SUPPORTED,
          `USDC not configured for chain ${params.chain}`,
          'Use a supported token on this chain.',
          false
        );
      }

      const erc20Abi = [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
        'function symbol() view returns (string)',
      ];
      const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, connectedSigner);

      // Check USDC balance first
      const usdcBalance = await tokenContract.balanceOf(signer.address);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/c6390672-1465-4a0d-bb12-57e7bed0bb2e', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'AgentWallet.ts:executeDirectTransfer:usdcBalance', message: 'USDC balance check', data: { signerAddress: signer.address, usdcContract: tokenAddress, usdcBalance: usdcBalance.toString(), requestedAmount: amount.toString(), chain: params.chain }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H6' }) }).catch(() => { });
      // #endregion

      if (usdcBalance < amount) {
        throw new AgentPaymentError(
          AgentPaymentErrorCode.INSUFFICIENT_BALANCE,
          `Insufficient USDC balance: have ${Number(usdcBalance) / 1e6} USDC (Circle USDC at ${tokenAddress}), need ${Number(amount) / 1e6} USDC. Note: Your wallet may have a different USDC token - only Circle's official testnet USDC is supported.`,
          `Get Circle USDC from https://faucet.circle.com for your wallet ${signer.address}.`,
          false
        );
      }

      tx = await tokenContract.transfer(params.recipient, amount);
    } else {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.TOKEN_NOT_SUPPORTED,
        `Token ${params.token} is not supported. Use 'eth', 'native', or 'usdc'.`,
        'Use a supported token symbol.',
        false
      );
    }

    // Wait for confirmation
    const receipt = await tx.wait();

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/c6390672-1465-4a0d-bb12-57e7bed0bb2e', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'AgentWallet.ts:executeDirectTransfer:success', message: 'Transfer confirmed', data: { txHash: tx.hash, blockNumber: receipt?.blockNumber }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H2,H5' }) }).catch(() => { });
    // #endregion

    return { transactionHash: tx.hash };
  }

  /**
   * Resolve a token symbol to its on-chain address for a given chain.
   * Returns 'native' for ETH, null if unknown.
   */
  private async resolveTokenAddress(token: string, chain: number): Promise<string | null> {
    const upper = token.toUpperCase();
    if (['ETH', 'NATIVE'].includes(upper)) return 'native';

    const USDC_ADDRESSES: Record<number, string> = {
      10002: '0x7A7754A2089df825801A0a8d95a9801928bFb22A',
      10003: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      10004: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      10005: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    };

    if (['USDC', 'USDT'].includes(upper)) {
      return USDC_ADDRESSES[chain] ?? null;
    }

    return null;
  }

  /**
   * Helper for retrying operations with exponential backoff.
   * Requirement 8.7
   */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        // Don't retry on certain errors (e.g. limit exceeded)
        if (error instanceof AgentPaymentError && !error.retryable) {
          throw error;
        }

        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          console.warn(`[AgentWallet] Attempt ${attempt + 1} failed. Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (lastError instanceof AgentPaymentError) throw lastError;
    throw new AgentPaymentError(
      AgentPaymentErrorCode.NETWORK_ERROR,
      `Operation failed after ${maxRetries} retries: ${lastError.message}`,
      'Check network connectivity or relayer status.',
      true,
      { originalError: lastError }
    );
  }
}
