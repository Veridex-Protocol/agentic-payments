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
    this.x402Client = new X402Client(this.sessionManager, null as any, config.x402);

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

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/c6390672-1465-4a0d-bb12-57e7bed0bb2e', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'AgentWallet.ts:pay:beforeDirectTransfer', message: 'About to execute direct transfer', data: { signerAddress: signer.address, targetChain: params.chain, token: params.token, amount: params.amount }, timestamp: Date.now(), sessionId: 'debug-session', hypothesisId: 'H2,H4,H5' }) }).catch(() => { });
    // #endregion

    // Execute direct transfer using session wallet (bypasses passkey requirement)
    const receipt = await this.withRetry(async () => {
      return await this.executeDirectTransfer(signer, params);
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

  async revokeSession(): Promise<void> {
    if (this.currentSession) {
      await this.sessionManager.revokeSession(this.currentSession.keyHash);
      this.currentSession = undefined;
    }
  }

  public getSessionStatus(): SessionStatus {
    if (!this.currentSession) throw new Error('No active session');
    return {
      isValid: this.sessionManager.isSessionValid(this.currentSession),
      keyHash: this.currentSession.keyHash,
      expiry: this.currentSession.config.expiryTimestamp,
      remainingDailyLimitUSD: this.currentSession.config.dailyLimitUSD - this.currentSession.metadata.dailySpentUSD,
      totalSpentUSD: this.currentSession.metadata.totalSpentUSD,
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
