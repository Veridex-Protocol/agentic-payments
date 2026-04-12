/**
 * @packageDocumentation
 * @module ReactHooks
 * @description
 * React Hooks for integrating Agent functionality into web apps.
 * 
 * Provides a set of convenient hooks (e.g., `useAgentWallet`, `usePayment`) that wrap
 * the imperative SDK methods into reactive primitives.
 * 
 * Example:
 * ```tsx
 * const { pay, isPaying } = usePayment(wallet);
 * ```
 */

import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { AgentWallet } from '../AgentWallet';
import { AgentWalletConfig, SessionStatus, PaymentReceipt, SpendingAlert, HistoryOptions } from '../types/agent';
import { CostEstimate, DetectionResult, ProtocolName, UniversalFetchOptions } from '../protocols/base/types';

// Re-export HistoryOptions with different name to avoid conflict
export type { HistoryOptions as HookHistoryOptions } from '../types/agent';

// Context for sharing wallet instance
const AgentWalletContext = createContext<AgentWallet | null>(null);

export interface AgentWalletProviderProps {
  config: AgentWalletConfig;
  children: React.ReactNode;
}

/**
 * Provider component for AgentWallet context.
 */
export function AgentWalletProvider(props: AgentWalletProviderProps): React.ReactElement {
  const { wallet } = useAgentWallet(props.config);

  // Use createElement to avoid JSX transpilation issues in .ts files
  const { createElement } = require('react');
  return createElement(
    AgentWalletContext.Provider,
    { value: wallet },
    props.children
  );
}

/**
 * Hook to access the AgentWallet from context.
 */
export function useAgentWalletContext(): AgentWallet | null {
  return useContext(AgentWalletContext);
}

/**
 * Hook to create and manage an AgentWallet instance.
 */
export function useAgentWallet(config?: AgentWalletConfig) {
  const [wallet, setWallet] = useState<AgentWallet | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (config) {
      setIsLoading(true);
      setError(null);
      const w = new AgentWallet(config);
      w.init()
        .then(() => {
          setWallet(w);
          setIsLoading(false);
        })
        .catch((err) => {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        });
    }
  }, [config]);

  return { wallet, isLoading, error };
}

/**
 * Hook to get and refresh session status.
 */
export function useSessionStatus(wallet: AgentWallet | null) {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [isExpired, setIsExpired] = useState(false);

  const refreshStatus = useCallback(() => {
    if (wallet) {
      const newStatus = wallet.getSessionStatus();
      setStatus(newStatus);
      setIsExpired(newStatus ? newStatus.expiry < Date.now() : false);
    } else {
      setStatus(null);
      setIsExpired(false);
    }
  }, [wallet]);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [refreshStatus]);

  return { status, isExpired, refreshStatus };
}

/**
 * Hook to fetch and manage payment history.
 */
export function usePaymentHistory(
  wallet: AgentWallet | null,
  options?: HistoryOptions
) {
  const [history, setHistory] = useState<PaymentReceipt[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!wallet) {
      setHistory([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await wallet.getPaymentHistory(options || {});
      setHistory(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [wallet, options]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { history, isLoading, error, refreshHistory: fetchHistory };
}

/**
 * Hook to subscribe to spending alerts.
 */
export function useSpendingAlerts(wallet: AgentWallet | null) {
  const [alerts, setAlerts] = useState<SpendingAlert[]>([]);
  const [latestAlert, setLatestAlert] = useState<SpendingAlert | null>(null);

  useEffect(() => {
    if (!wallet) return;

    // Subscribe to alerts - wallet.onSpendingAlert registers a callback
    wallet.onSpendingAlert((alert: SpendingAlert) => {
      setLatestAlert(alert);
      setAlerts((prev) => [...prev, alert]);
    });

    // Note: Current implementation doesn't return unsubscribe function
    // Future improvement: add unsubscribe support to AlertManager
  }, [wallet]);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
    setLatestAlert(null);
  }, []);

  return { alerts, latestAlert, clearAlerts };
}

export interface ChainBalanceInfo {
  chain: number;
  chainName?: string;
  token: string;
  balance: bigint;
  balanceUSD: number;
}

/**
 * Hook to fetch balances across multiple chains.
 */
export function useMultiChainBalance(wallet: AgentWallet | null) {
  const [balances, setBalances] = useState<ChainBalanceInfo[]>([]);
  const [totalUSD, setTotalUSD] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchBalances = useCallback(async () => {
    if (!wallet) {
      setBalances([]);
      setTotalUSD(0);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await wallet.getMultiChainBalance();
      // Convert PortfolioBalance to ChainBalanceInfo array
      const balanceArray: ChainBalanceInfo[] = [];
      if (result && typeof result === 'object') {
        for (const [chainKey, chainBalances] of Object.entries(result)) {
          if (Array.isArray(chainBalances)) {
            for (const bal of chainBalances) {
              balanceArray.push({
                chain: parseInt(chainKey) || 0,
                token: bal.token || 'native',
                balance: BigInt(bal.balance || 0),
                balanceUSD: bal.balanceUSD || 0,
              });
            }
          }
        }
      }
      setBalances(balanceArray);
      setTotalUSD(balanceArray.reduce((sum, b) => sum + b.balanceUSD, 0));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  return { balances, totalUSD, isLoading, error, refreshBalances: fetchBalances };
}

/**
 * Hook for making payments with state management.
 */
export function usePayment(wallet: AgentWallet | null) {
  const [isPaying, setIsPaying] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<PaymentReceipt | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const pay = useCallback(
    async (params: {
      amount: string;
      token: string;
      recipient: string;
      chain: number;
      memo?: string;
    }) => {
      if (!wallet) {
        throw new Error('Wallet not initialized');
      }

      setIsPaying(true);
      setError(null);

      try {
        const receipt = await wallet.pay(params);
        setLastReceipt(receipt);
        return receipt;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsPaying(false);
      }
    },
    [wallet]
  );

  return { pay, isPaying, lastReceipt, error };
}

/**
 * Hook for checking if wallet can make a payment.
 */
export function useCanPay(wallet: AgentWallet | null, amountUSD: number) {
  const { status } = useSessionStatus(wallet);

  const canPay = status
    ? status.isValid &&
    amountUSD <= status.remainingDailyLimitUSD &&
    status.expiry > Date.now()
    : false;

  const reason = !status
    ? 'No active session'
    : !status.isValid
      ? 'Session not valid'
      : amountUSD > status.remainingDailyLimitUSD
        ? 'Exceeds daily limit'
        : status.expiry <= Date.now()
          ? 'Session expired'
          : null;

  return { canPay, reason };
}

/**
 * Hook for making paid HTTP requests with automatic protocol detection.
 * This is the React equivalent of Thirdweb's `useFetchWithPayment` but
 * with Veridex session keys, cross-chain support, and multi-protocol detection.
 *
 * @example
 * ```tsx
 * function PaidContent() {
 *   const { fetchWithPayment, data, isPending, error, detectedProtocol } =
 *     useFetchWithPayment(wallet);
 *
 *   return (
 *     <button onClick={() => fetchWithPayment('https://api.example.com/premium')}
 *       disabled={isPending}>
 *       {isPending ? 'Paying...' : 'Get Premium Content'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useFetchWithPayment<T = any>(wallet: AgentWallet | null) {
  const [data, setData] = useState<T | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [detectedProtocol, setDetectedProtocol] = useState<ProtocolName | null>(null);
  const [lastSettlement, setLastSettlement] = useState<any>(null);

  const fetchWithPayment = useCallback(
    async (
      url: string,
      options?: UniversalFetchOptions & {
        /** Parse response as JSON (default: true) */
        parseJson?: boolean;
      }
    ): Promise<T | null> => {
      if (!wallet) {
        setError(new Error('Wallet not initialized'));
        return null;
      }

      setIsPending(true);
      setError(null);
      setCostEstimate(null);
      setDetectedProtocol(null);

      try {
        const response = await wallet.fetch(url, {
          ...options,
          onProtocolDetected: (result: DetectionResult) => {
            setDetectedProtocol(result.protocol);
            options?.onProtocolDetected?.(result);
          },
          onBeforePayment: async (estimate: CostEstimate) => {
            setCostEstimate(estimate);
            if (options?.onBeforePayment) {
              return options.onBeforePayment(estimate);
            }
            return true; // Auto-approve by default
          },
          onAfterPayment: (settlement) => {
            setLastSettlement(settlement);
            options?.onAfterPayment?.(settlement);
          },
        });

        if (!response.ok) {
          throw new Error(`Request failed: ${response.status} ${response.statusText}`);
        }

        const parseJson = options?.parseJson !== false;
        const result = parseJson ? await response.json() : await response.text();
        setData(result as T);
        return result as T;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        return null;
      } finally {
        setIsPending(false);
      }
    },
    [wallet]
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setCostEstimate(null);
    setDetectedProtocol(null);
    setLastSettlement(null);
  }, []);

  return {
    fetchWithPayment,
    data,
    isPending,
    error,
    costEstimate,
    detectedProtocol,
    lastSettlement,
    reset,
  };
}

/**
 * Hook for estimating payment cost before executing.
 * Useful for showing price previews in UI.
 *
 * @example
 * ```tsx
 * function PricePreview({ url }: { url: string }) {
 *   const { estimate, isLoading } = useCostEstimate(wallet, url);
 *   if (isLoading) return <span>Checking price...</span>;
 *   if (!estimate) return <span>Free</span>;
 *   return <span>${estimate.amountUSD.toFixed(2)} via {estimate.scheme}</span>;
 * }
 * ```
 */
export function useCostEstimate(
  wallet: AgentWallet | null,
  url: string | null
) {
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchEstimate = useCallback(async () => {
    if (!wallet || !url) {
      setEstimate(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await wallet.estimateCost(url);
      setEstimate(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [wallet, url]);

  useEffect(() => {
    fetchEstimate();
  }, [fetchEstimate]);

  return { estimate, isLoading, error, refresh: fetchEstimate };
}

/**
 * Hook for detecting which payment protocol a URL uses.
 *
 * @example
 * ```tsx
 * function ProtocolBadge({ url }: { url: string }) {
 *   const { protocol, isDetecting } = useProtocolDetection(wallet, url);
 *   if (isDetecting) return <span>Detecting...</span>;
 *   if (!protocol) return <span>No payment required</span>;
 *   return <span>Protocol: {protocol}</span>;
 * }
 * ```
 */
export function useProtocolDetection(
  wallet: AgentWallet | null,
  url: string | null
) {
  const [protocol, setProtocol] = useState<ProtocolName | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const detect = useCallback(async () => {
    if (!wallet || !url) {
      setProtocol(null);
      return;
    }

    setIsDetecting(true);
    setError(null);

    try {
      const response = await globalThis.fetch(url, { method: 'HEAD' });
      const detector = wallet.getProtocolDetector();
      const result = await detector.detectWithMetadata(response, url);
      setProtocol(result?.protocol ?? null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsDetecting(false);
    }
  }, [wallet, url]);

  useEffect(() => {
    detect();
  }, [detect]);

  return { protocol, isDetecting, error, redetect: detect };
}
