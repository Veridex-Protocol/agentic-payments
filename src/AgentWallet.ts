import { VeridexSDK, TokenBalance, PortfolioBalance, createSDK, ChainName, PasskeyCredential } from '@veridex/sdk';
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
    this.x402Client = new X402Client(this.sessionManager, null as any);

    if (config.mcp?.enabled) {
      this.mcpServer = new MCPServer(this);
    }
  }

  async init(): Promise<void> {
    // Default to Base if no chains specified
    const hubChain = 'base' as ChainName;
    this.coreSDK = createSDK(hubChain, {
      relayerUrl: this.config.relayerUrl,
      relayerApiKey: this.config.relayerApiKey,
    });

    // Update x402Client with initialized coreSDK
    (this.x402Client as any).coreSDK = this.coreSDK;

    this.currentSession = await this.createSession({
      dailyLimitUSD: this.config.session.dailyLimitUSD,
      perTransactionLimitUSD: this.config.session.perTransactionLimitUSD,
      expiryTimestamp: Date.now() + (this.config.session.expiryHours * 60 * 60 * 1000),
      allowedChains: this.config.session.allowedChains
    });
  }

  /**
 * Create a new session key with specific config
 */
  async createSession(config: SessionKeyConfig): Promise<StoredSession> {
    return await this.sessionManager.createSession(this.config.masterCredential, config);
  }

  async fetch(url: string, options?: RequestInit): Promise<Response> {
    if (!this.currentSession) await this.init();

    return await this.withRetry(async () => {
      return await this.x402Client.handleFetch(url, options, this.currentSession!);
    });
  }

  async pay(params: PaymentParams): Promise<PaymentReceipt> {
    if (!this.currentSession) await this.init();

    // Check limits
    const amountUSD = parseFloat(params.amount); // Simplification
    const limitCheck = this.sessionManager.checkLimits(this.currentSession!, amountUSD);
    if (!limitCheck.allowed) {
      throw AgentPaymentError.fromLimitExceeded(limitCheck.reason || 'Transaction exceeds session limits');
    }

    // 1. Find optimal route (Source chain detection)
    const sourceChain = params.chain; // For now assume same chain
    // unused route for now
    // const route = await this.router.findOptimalRoute(sourceChain, params.chain, BigInt(params.amount));

    // 2. Execute payment via Core SDK
    // Get signer from session (handles encryption properly)
    const signer = await this.sessionManager.getSessionWallet(
      this.currentSession!,
      this.config.masterCredential.credentialId
    );

    const receipt = await this.withRetry(async () => {
      return await this.coreSDK.transfer({
        recipient: params.recipient,
        amount: BigInt(params.amount),
        token: params.token,
        targetChain: params.chain
      }, signer);
    });

    // Record spending
    await this.sessionManager.recordSpending(this.currentSession!, amountUSD);

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

  async revokeSession(): Promise<void> {
    if (this.currentSession) {
      await this.sessionManager.revokeSession(this.currentSession.keyHash);
      this.currentSession = undefined;
    }
  }

  getSessionStatus(): SessionStatus {
    if (!this.currentSession) return { isValid: false, keyHash: '', expiry: 0, remainingDailyLimitUSD: 0, totalSpentUSD: 0 };

    return {
      isValid: this.sessionManager.isSessionValid(this.currentSession),
      keyHash: this.currentSession.keyHash,
      expiry: this.currentSession.config.expiryTimestamp,
      remainingDailyLimitUSD: this.currentSession.config.dailyLimitUSD - this.currentSession.metadata.dailySpentUSD,
      totalSpentUSD: this.currentSession.metadata.totalSpentUSD
    };
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
