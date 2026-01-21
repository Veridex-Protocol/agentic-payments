/**
 * @packageDocumentation
 * @module SessionStorage
 * @description
 * Persistence layer for agent session keys.
 * 
 * Handles the secure storage and retrieval of `StoredSession` objects.
 * 
 * Security Note:
 * - Session private keys are stored ENCRYPTED (AES-GCM).
 * - This module does NOT handle decryption; it only stores the encrypted blob.
 * - In a browser environment, this uses `localStorage`. In Node.js, it could be adapted to use
 *   a filesystem or database adapter.
 */
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
