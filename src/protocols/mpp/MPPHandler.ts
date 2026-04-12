/**
 * @packageDocumentation
 * @module MPPHandler
 * @description
 * Protocol handler for MPP (Micropayments Protocol) / Tempo.
 *
 * Implements the MPP specification (https://mpp.dev/):
 * - Detects 402 responses with `WWW-Authenticate: Payment` header
 * - Parses MPP Challenge (method, intent, request fields)
 * - Creates MPP Credential (authorization proof)
 * - Retries request with `Authorization` header
 * - Extracts `Payment-Receipt` from successful response
 *
 * Supports:
 * - Charge intents (one-time payments)
 * - Session intents (streaming/metered billing)
 * - MCP transport binding (error code -32042)
 *
 * Reference: https://mpp.dev/llms-full.txt
 */

import { ProtocolHandler } from '../base/ProtocolHandler';
import { CostEstimate, PaymentSettlement, ProtocolContext, ProtocolName } from '../base/types';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';

// ── MPP Types ──

/** MPP Challenge parsed from WWW-Authenticate header */
export interface MPPChallenge {
  /** Payment method identifier */
  method: string;
  /** Intent type: charge (one-time) or session (streaming) */
  intentType: 'charge' | 'session';
  /** Payment amount in smallest unit */
  amount?: string;
  /** Currency/token */
  currency?: string;
  /** Payment network */
  network?: string;
  /** Payment recipient */
  recipient?: string;
  /** Unique request identifier */
  requestId?: string;
  /** Challenge description */
  description?: string;
  /** Raw challenge parameters */
  params: Record<string, string>;
}

/** MPP Credential sent in Authorization header */
export interface MPPCredential {
  /** Payment method used */
  method: string;
  /** Transaction hash or payment proof */
  proof: string;
  /** Network where payment was made */
  network?: string;
  /** Serialized credential string */
  serialized: string;
}

/** MPP Receipt from Payment-Receipt header */
export interface MPPReceipt {
  /** Receipt status */
  status: 'paid' | 'pending' | 'failed';
  /** Transaction reference */
  txRef?: string;
  /** Amount confirmed */
  amount?: string;
  /** Raw receipt string */
  raw: string;
}

/** Configuration for MPP handler */
export interface MPPHandlerConfig {
  /** Default network for payments (e.g., 'tempo-testnet', 'tempo-mainnet') */
  defaultNetwork?: string;
  /** Tempo RPC endpoint */
  tempoRpcUrl?: string;
  /** Payment method preference order */
  preferredMethods?: string[];
}

// ── Constants ──

const HEADER_WWW_AUTHENTICATE = 'www-authenticate';
const HEADER_AUTHORIZATION = 'authorization';
const HEADER_PAYMENT_RECEIPT = 'payment-receipt';
const MPP_AUTH_SCHEME = 'payment';

// ── Implementation ──

export class MPPHandler extends ProtocolHandler {
  readonly protocolName: ProtocolName = 'mpp';
  readonly priority = 85; // Between ACP(90) and AP2(80)

  private readonly mppConfig: MPPHandlerConfig;

  constructor(config?: MPPHandlerConfig) {
    super();
    this.mppConfig = {
      defaultNetwork: config?.defaultNetwork ?? 'tempo-testnet',
      tempoRpcUrl: config?.tempoRpcUrl,
      preferredMethods: config?.preferredMethods ?? ['tempo'],
    };
  }

  async canHandle(response: Response, _url: string): Promise<boolean> {
    if (response.status !== 402) return false;

    const wwwAuth = response.headers.get(HEADER_WWW_AUTHENTICATE);
    if (!wwwAuth) return false;

    // MPP uses "Payment" scheme in WWW-Authenticate
    return wwwAuth.toLowerCase().startsWith(MPP_AUTH_SCHEME);
  }

  async handle(
    url: string,
    options: RequestInit,
    context: ProtocolContext,
    originalResponse?: Response,
  ): Promise<Response> {
    if (!originalResponse) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'MPP handler requires the original 402 response',
        'Ensure the original response is passed to the handler.',
        false,
      );
    }

    // Step 1: Parse the Challenge
    const challenge = this.parseChallenge(originalResponse);
    if (!challenge) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'Failed to parse MPP challenge from 402 response',
        'The WWW-Authenticate header was missing or malformed.',
        false,
      );
    }

    // Step 2: Check limits
    const amountUSD = await this.estimateUSDFromChallenge(challenge, context);
    const { session } = context;

    if (amountUSD > session.config.perTransactionLimitUSD) {
      throw AgentPaymentError.fromLimitExceeded(
        `MPP payment $${amountUSD.toFixed(2)} exceeds per-transaction limit $${session.config.perTransactionLimitUSD}`,
        { amount: challenge.amount, amountUSD },
      );
    }

    const remainingDaily = session.config.dailyLimitUSD - session.metadata.dailySpentUSD;
    if (amountUSD > remainingDaily) {
      throw AgentPaymentError.fromLimitExceeded(
        `MPP payment $${amountUSD.toFixed(2)} exceeds remaining daily limit $${remainingDaily.toFixed(2)}`,
        { amount: challenge.amount, amountUSD, remainingDaily },
      );
    }

    // Step 3: Create the Credential (payment proof)
    const credential = await this.createCredential(challenge, context);

    // Step 4: Retry with Authorization header
    const retryHeaders = new Headers(options.headers);
    retryHeaders.set(HEADER_AUTHORIZATION, credential.serialized);

    const retryResponse = await globalThis.fetch(url, { ...options, headers: retryHeaders });

    // Step 5: Handle the response
    if (retryResponse.status === 402) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'MPP payment was rejected by the server',
        'The credential was not accepted. Check balance or payment method.',
        false,
      );
    }

    return retryResponse;
  }

  async estimateCost(response: Response): Promise<CostEstimate> {
    const challenge = this.parseChallenge(response);
    if (!challenge) {
      return {
        amountUSD: 0,
        amountRaw: '0',
        token: 'unknown',
        chain: 0,
        scheme: 'exact',
        confidence: 0,
        description: 'Could not parse MPP challenge',
      };
    }

    const amountRaw = challenge.amount ?? '0';
    const token = challenge.currency ?? 'USDC';
    const amountUSD = this.roughUSDEstimate(amountRaw, token);
    const scheme = challenge.intentType === 'session' ? 'streaming' : 'exact';

    return {
      amountUSD,
      amountRaw,
      token,
      chain: this.networkToChainId(challenge.network),
      scheme,
      confidence: token.toUpperCase().includes('USD') ? 0.95 : 0.5,
      description: `MPP ${challenge.intentType} payment of ${amountRaw} ${token} via ${challenge.method}`,
    };
  }

  async settle(
    paymentData: unknown,
    _context: ProtocolContext,
  ): Promise<PaymentSettlement> {
    const data = paymentData as { txHash?: string; network?: string; amount?: string; token?: string };
    return {
      success: true,
      protocol: 'mpp',
      txHash: data.txHash,
      network: data.network ?? this.mppConfig.defaultNetwork!,
      amount: data.amount ?? '0',
      token: data.token ?? 'USDC',
      settledAt: Date.now(),
      metadata: { handler: 'mpp' },
    };
  }

  // ── Challenge Parsing ──

  /**
   * Parse MPP Challenge from WWW-Authenticate header.
   * Format: Payment method="tempo", intent="charge", amount="1000", currency="USDC", ...
   */
  private parseChallenge(response: Response): MPPChallenge | null {
    const wwwAuth = response.headers.get(HEADER_WWW_AUTHENTICATE);
    if (!wwwAuth) return null;

    const lower = wwwAuth.toLowerCase();
    if (!lower.startsWith(MPP_AUTH_SCHEME)) return null;

    // Parse key=value pairs from the header
    const params = this.parseAuthParams(wwwAuth.substring(MPP_AUTH_SCHEME.length).trim());

    const intentType = (params.intent ?? 'charge') as 'charge' | 'session';
    if (intentType !== 'charge' && intentType !== 'session') return null;

    return {
      method: params.method ?? 'tempo',
      intentType,
      amount: params.amount,
      currency: params.currency ?? params.token,
      network: params.network,
      recipient: params.recipient ?? params.payee,
      requestId: params.request_id ?? params.requestid,
      description: params.description,
      params,
    };
  }

  /**
   * Parse auth parameters from a WWW-Authenticate header value.
   * Handles both quoted and unquoted values.
   */
  private parseAuthParams(headerValue: string): Record<string, string> {
    const params: Record<string, string> = {};
    // Match key="value" or key=value patterns
    const regex = /(\w+)=(?:"([^"]*)"|([^\s,]*))/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(headerValue)) !== null) {
      const key = match[1].toLowerCase();
      const value = match[2] ?? match[3];
      params[key] = value;
    }
    return params;
  }

  // ── Credential Creation ──

  /**
   * Create an MPP Credential from a Challenge.
   * For Tempo payments, this signs a transfer authorization.
   */
  private async createCredential(
    challenge: MPPChallenge,
    context: ProtocolContext,
  ): Promise<MPPCredential> {
    if (!context.signerWallet) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'MPP credential creation requires a signer wallet',
        'Ensure the session wallet is available in the protocol context.',
        false,
      );
    }

    // Sign the challenge parameters as proof of payment authorization
    const messageData = JSON.stringify({
      method: challenge.method,
      intent: challenge.intentType,
      amount: challenge.amount,
      currency: challenge.currency,
      recipient: challenge.recipient,
      requestId: challenge.requestId,
      timestamp: Date.now(),
    });

    const proof = await context.signerWallet.signMessage(messageData);

    const serialized = `Payment method="${challenge.method}", proof="${proof}", address="${context.signerWallet.address}"`;

    return {
      method: challenge.method,
      proof,
      network: challenge.network ?? this.mppConfig.defaultNetwork,
      serialized,
    };
  }

  // ── Receipt Parsing ──

  /**
   * Extract MPP Receipt from a successful response.
   */
  extractReceipt(response: Response): MPPReceipt | null {
    const receiptHeader = response.headers.get(HEADER_PAYMENT_RECEIPT);
    if (!receiptHeader) return null;

    const params = this.parseAuthParams(receiptHeader);
    return {
      status: (params.status as MPPReceipt['status']) ?? 'paid',
      txRef: params.tx_ref ?? params.txref ?? params.reference,
      amount: params.amount,
      raw: receiptHeader,
    };
  }

  // ── Helpers ──

  private async estimateUSDFromChallenge(
    challenge: MPPChallenge,
    context: ProtocolContext,
  ): Promise<number> {
    if (!challenge.amount) return 0;
    const token = challenge.currency ?? 'USDC';
    const chain = this.networkToChainId(challenge.network);

    if (context.estimateUSD) {
      return context.estimateUSD(token, challenge.amount, chain);
    }
    return this.roughUSDEstimate(challenge.amount, token);
  }

  private roughUSDEstimate(amount: string, token: string): number {
    const parsed = parseFloat(amount);
    if (isNaN(parsed)) return 0;
    const stablecoins = ['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'USD'];
    const isStable = stablecoins.some((s) => token.toUpperCase().includes(s));
    if (isStable) {
      // If amount looks like atomic units (> 1M), assume 6 decimals
      return parsed > 1_000_000 ? parsed / 1_000_000 : parsed;
    }
    return parsed > 1_000_000 ? parsed / 1_000_000 : parsed;
  }

  private networkToChainId(network?: string): number {
    if (!network) return 0;
    const map: Record<string, number> = {
      'tempo-mainnet': 0, // Tempo doesn't have a Wormhole chain ID yet
      'tempo-testnet': 0,
      ethereum: 2,
      base: 30,
      'base-sepolia': 10004,
      'ethereum-sepolia': 10002,
    };
    return map[network.toLowerCase()] ?? 0;
  }
}
