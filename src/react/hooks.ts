import { useState, useEffect, useCallback } from 'react';
import { AgentWallet } from '../AgentWallet';
import { AgentWalletConfig, SessionStatus, PaymentReceipt } from '../types/agent';

export function useAgentWallet(config?: AgentWalletConfig) {
  const [wallet, setWallet] = useState<AgentWallet | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (config) {
      setIsLoading(true);
      const w = new AgentWallet(config);
      w.init()
        .then(() => {
          setWallet(w);
          setIsLoading(false);
        })
        .catch((err) => {
          setError(err);
          setIsLoading(false);
        });
    }
  }, [config]);

  return { wallet, isLoading, error };
}

export function useSessionStatus(wallet: AgentWallet | null) {
  const [status, setStatus] = useState<SessionStatus | null>(null);

  const refreshStatus = useCallback(() => {
    if (wallet) {
      setStatus(wallet.getSessionStatus());
    }
  }, [wallet]);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [refreshStatus]);

  return { status, refreshStatus };
}

export function usePaymentHistory(wallet: AgentWallet | null) {
  const [history, setHistory] = useState<PaymentReceipt[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    if (wallet) {
      setIsLoading(true);
      // In a real implementation, wallet would have a method to fetch history
      // setHistory(await wallet.getPaymentHistory());
      setIsLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { history, isLoading, refreshHistory: fetchHistory };
}
