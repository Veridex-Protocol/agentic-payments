/**
 * @packageDocumentation
 * @module SessionKeyManager
 * @description
 * Manages the lifecycle of secure, ephemeral session keys for autonomous agent payments.
 * 
 * Session keys are the core security primitive of the Agent SDK. They are temporary, bounded
 * keys derived from a master passkey (or wallet) that allow the agent to operate autonomously
 * without exposing the master credentials.
 * 
 * Features:
 * - **Key Derivation**: Securely derives keys using `secp256k1` (EVM compatible).
 * - **Encryption**: Private keys are encrypted at rest.
 * - **Policy Enforcement**: Enforces daily spending limits and expiration times.
 * - **Revocation**: Instant revocation capability for all sessions.
 * 
 * @see {@link SessionStorage} for persistence details.
 */

import { ethers } from 'ethers';
import {
  PasskeyCredential,
  generateSecp256k1KeyPair,
  computeSessionKeyHash,
  deriveEncryptionKey,
  encrypt,
  decrypt,
} from '@veridex/sdk';
import { SessionStorage, StoredSession, SessionKeyConfig } from './SessionStorage';
import { SpendingTracker, LimitCheckResult } from './SpendingTracker';
import { AgentPaymentError, AgentPaymentErrorCode } from '../types/errors';

export class SessionKeyManager {
  private storage: SessionStorage;
  private tracker: SpendingTracker;
  private encryptionKey?: CryptoKey;

  constructor() {
    this.storage = new SessionStorage();
    this.tracker = new SpendingTracker();
  }

  /**
   * Create a new session key with specified configuration.
   * 
   * The session key is:
   * 1. Generated using secp256k1 (compatible with EVM signing)
   * 2. Encrypted at rest using key derived from master passkey
   * 3. Stored securely with spending metadata
   * 
   * @param masterKey - Master passkey credential (for key derivation and encryption)
   * @param config - Session configuration (limits, expiry, allowed chains)
   * @returns Created session with encrypted private key
   */
  async createSession(
    masterKey: PasskeyCredential,
    config: SessionKeyConfig
  ): Promise<StoredSession> {
    // Validate configuration
    this.validateConfig(config);

    // Generate new secp256k1 key pair using core SDK
    const keyPair = generateSecp256k1KeyPair();

    // Compute session key hash (on-chain identifier)
    const keyHash = computeSessionKeyHash(keyPair.publicKey);

    // Derive encryption key from master passkey credential
    // This ensures only the owner of the passkey can decrypt session keys
    if (!this.encryptionKey) {
      this.encryptionKey = await deriveEncryptionKey(masterKey.credentialId);
    }

    // Encrypt the private key for storage
    const encryptedPrivateKey = await this.encryptPrivateKey(
      keyPair.privateKey,
      this.encryptionKey
    );

    // Build session record
    const session: StoredSession = {
      keyHash,
      encryptedPrivateKey,
      publicKey: ethers.hexlify(keyPair.publicKey),
      config,
      metadata: {
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        totalSpentUSD: 0,
        dailySpentUSD: 0,
        dailyResetAt: Date.now() + 24 * 60 * 60 * 1000,
        transactionCount: 0,
      },
      masterKeyHash: masterKey.keyHash,
    };

    // Persist to storage
    await this.storage.saveSession(session);

    return session;
  }

  /**
   * Import an existing session (e.g. from frontend provisioning).
   */
  async importSession(session: StoredSession): Promise<void> {
    await this.storage.saveSession(session);
  }

  /**
   * Load an existing session by key hash.
   */
  async loadSession(keyHash: string): Promise<StoredSession | null> {
    return await this.storage.getSession(keyHash);
  }

  /**
   * Check if a transaction is within session spending limits.
   * 
   * @param session - Active session
   * @param amountUSD - Transaction amount in USD
   * @returns Limit check result with allow/deny and reason
   */
  checkLimits(session: StoredSession, amountUSD: number): LimitCheckResult {
    // First, check if session is still valid
    if (!this.isSessionValid(session)) {
      return {
        allowed: false,
        reason: 'Session has expired',
        remainingDailyLimitUSD: 0,
      };
    }

    return this.tracker.checkLimits(session, amountUSD);
  }

  /**
   * Record spending after a successful transaction.
   * 
   * @param session - Session that made the payment
   * @param amountUSD - Amount spent in USD
   */
  async recordSpending(session: StoredSession, amountUSD: number): Promise<void> {
    this.tracker.recordSpending(session, amountUSD);
    session.metadata.lastUsedAt = Date.now();
    await this.storage.saveSession(session);
  }

  /**
   * Revoke a session immediately.
   * After revocation, the session cannot be used for any further transactions.
   * 
   * @param keyHash - Session key hash to revoke
   */
  async revokeSession(keyHash: string): Promise<void> {
    await this.storage.removeSession(keyHash);
  }

  /**
   * Check if a session is still valid (not expired).
   */
  isSessionValid(session: StoredSession): boolean {
    const now = Date.now();

    // Check expiration
    if (now >= session.config.expiryTimestamp) {
      return false;
    }

    return true;
  }

  /**
   * Get all active sessions for a master key.
   */
  async getSessionsForMasterKey(masterKeyHash: string): Promise<StoredSession[]> {
    const allSessions = await this.storage.getAllSessions();
    return allSessions.filter(
      (s) => s.masterKeyHash === masterKeyHash && this.isSessionValid(s)
    );
  }

  /**
   * Decrypt the session private key for signing.
   * 
   * This should only be called when a signature is needed.
   * The decrypted key should not be stored in memory longer than necessary.
   */
  async getDecryptedPrivateKey(
    session: StoredSession,
    masterCredentialId: string
  ): Promise<Uint8Array> {
    // Derive encryption key if not cached
    if (!this.encryptionKey) {
      this.encryptionKey = await deriveEncryptionKey(masterCredentialId);
    }

    // Handle both encrypted (base64) and unencrypted (hex) formats
    // This provides backwards compatibility during migration
    // Check for raw private key (32 bytes = 66 chars including 0x prefix)
    if (session.encryptedPrivateKey.startsWith('0x') && session.encryptedPrivateKey.length === 66) {
      // Unencrypted hex format (legacy/development)
      console.warn('[SessionKeyManager] Session using unencrypted private key - migrate to encrypted storage');
      return ethers.getBytes(session.encryptedPrivateKey);
    }

    // If it starts with 0x but is longer, it's a HEX-encoded ENCRYPTED blob (from frontend)
    let encryptedBytes: Uint8Array;

    if (session.encryptedPrivateKey.startsWith('0x')) {
      encryptedBytes = ethers.getBytes(session.encryptedPrivateKey);
    } else {
      // Assume Base64
      encryptedBytes = Uint8Array.from(
        Buffer.from(session.encryptedPrivateKey, 'base64')
      );
    }

    return await decrypt(encryptedBytes, this.encryptionKey);
  }

  /**
   * Create an ethers Wallet from a session for signing.
   * 
   * Note: In production, consider using a more secure signing approach
   * that doesn't expose the private key in memory.
   */
  async getSessionWallet(
    session: StoredSession,
    masterCredentialId: string
  ): Promise<ethers.Wallet> {
    // Only treat as raw private key if it's 0x AND exactly 32 bytes (66 chars)
    if (session.encryptedPrivateKey.startsWith('0x') && session.encryptedPrivateKey.length === 66) {
      return new ethers.Wallet(session.encryptedPrivateKey);
    }

    const privateKey = await this.getDecryptedPrivateKey(session, masterCredentialId);
    return new ethers.Wallet(ethers.hexlify(privateKey));
  }

  /**
   * Encrypt a private key for secure storage.
   */
  private async encryptPrivateKey(
    privateKey: Uint8Array,
    encryptionKey: CryptoKey
  ): Promise<string> {
    const encrypted = await encrypt(privateKey, encryptionKey);
    return Buffer.from(encrypted).toString('base64');
  }

  /**
   * Validate session configuration.
   */
  private validateConfig(config: SessionKeyConfig): void {
    if (config.dailyLimitUSD <= 0) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.SESSION_INVALID,
        'Daily limit must be greater than 0',
        'Specify a positive daily spending limit in USD.',
        false
      );
    }

    if (config.perTransactionLimitUSD <= 0) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.SESSION_INVALID,
        'Per-transaction limit must be greater than 0',
        'Specify a positive per-transaction limit in USD.',
        false
      );
    }

    if (config.perTransactionLimitUSD > config.dailyLimitUSD) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.SESSION_INVALID,
        'Per-transaction limit cannot exceed daily limit',
        'Set per-transaction limit less than or equal to daily limit.',
        false
      );
    }

    if (config.expiryTimestamp <= Date.now()) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.SESSION_INVALID,
        'Session expiry must be in the future',
        'Specify an expiry timestamp in the future.',
        false
      );
    }

    // Max session duration: 24 hours (86400 seconds)
    const maxExpiry = Date.now() + 24 * 60 * 60 * 1000;
    if (config.expiryTimestamp > maxExpiry) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.SESSION_INVALID,
        'Session duration cannot exceed 24 hours',
        'Set expiry to within 24 hours from now.',
        false
      );
    }

    if (!config.allowedChains || config.allowedChains.length === 0) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.SESSION_INVALID,
        'At least one allowed chain must be specified',
        'Provide an array of Wormhole chain IDs.',
        false
      );
    }
  }
}
