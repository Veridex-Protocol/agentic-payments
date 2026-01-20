import { ethers } from 'ethers';

export interface SessionKeyConfig {
  dailyLimitUSD: number;
  perTransactionLimitUSD: number;
  expiryTimestamp: number;
  allowedChains: number[];
}

export interface StoredSession {
  keyHash: string;
  encryptedPrivateKey: string; // AES-256-GCM encrypted
  publicKey: string;
  config: SessionKeyConfig;
  metadata: {
    createdAt: number;
    lastUsedAt: number;
    totalSpentUSD: number;
    dailySpentUSD: number;
    dailyResetAt: number;
    transactionCount: number;
  };
  masterKeyHash: string; // Reference to master passkey
}

export class SessionStorage {
  private static readonly STORAGE_KEY_PREFIX = 'veridex_session_';

  async saveSession(session: StoredSession): Promise<void> {
    const key = `${SessionStorage.STORAGE_KEY_PREFIX}${session.keyHash}`;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(session));
    }
  }

  async getSession(keyHash: string): Promise<StoredSession | null> {
    const key = `${SessionStorage.STORAGE_KEY_PREFIX}${keyHash}`;
    if (typeof localStorage !== 'undefined') {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : null;
    }
    return null;
  }

  async removeSession(keyHash: string): Promise<void> {
    const key = `${SessionStorage.STORAGE_KEY_PREFIX}${keyHash}`;
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  }

  async getAllSessions(): Promise<StoredSession[]> {
    const sessions: StoredSession[] = [];
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(SessionStorage.STORAGE_KEY_PREFIX)) {
          const data = localStorage.getItem(key);
          if (data) sessions.push(JSON.parse(data));
        }
      }
    }
    return sessions;
  }
}
