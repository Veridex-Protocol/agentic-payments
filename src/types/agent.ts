import { PasskeyCredential, TokenBalance, PortfolioBalance } from '@veridex/sdk';

export interface AgentWalletConfig {
  // Master passkey credential (from @veridex/sdk)
  masterCredential: PasskeyCredential;

  // Session key configuration
  session: {
    dailyLimitUSD: number;
    perTransactionLimitUSD: number;
    expiryHours: number;
    allowedChains: number[]; // Wormhole chain IDs
  };

  // Optional relayer for gasless transactions
  relayerUrl?: string;
  relayerApiKey?: string;

  // Optional UCP configuration
  ucp?: {
    enabled: boolean;
    merchantId?: string;
    callbackUrl?: string;
  };

  // Optional MCP server configuration
  mcp?: {
    enabled: boolean;
    port?: number;
    allowedOrigins?: string[];
  };
}

export interface PaymentParams {
  amount: string;
  token: string;
  recipient: string;
  chain: number;
  protocol?: 'x402' | 'ucp' | 'direct';
  metadata?: Record<string, any>;
}

export interface PaymentReceipt {
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed';
  chain: number;
  token: string;
  amount: bigint;
  amountUSD?: number;
  recipient: string;
  protocol?: 'x402' | 'ucp' | 'direct';
  timestamp: number;
}

export interface SessionStatus {
  isValid: boolean;
  keyHash: string;
  expiry: number;
  remainingDailyLimitUSD: number;
  totalSpentUSD: number;
}

export interface HistoryOptions {
  limit?: number;
  offset?: number;
  chain?: number;
  startTime?: number;
  endTime?: number;
}

export interface SpendingAlert {
  type: 'WARNING' | 'CRITICAL' | 'threshold_reached' | 'limit_exceeded' | 'anomaly_detected';
  severity?: 'info' | 'warning' | 'critical';
  message: string;
  sessionKeyHash: string;
  dailySpentUSD: number;
  dailyLimitUSD: number;
  timestamp: number;
  data?: Record<string, any>;
}
