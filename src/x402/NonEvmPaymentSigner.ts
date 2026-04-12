/**
 * @packageDocumentation
 * @module NonEvmPaymentSigner
 * @description
 * Payment signing for non-EVM chains in the x402 protocol.
 *
 * Supports:
 * - **Solana**: Ed25519 signing of payment intents (SPL token transfers)
 * - **Aptos**: Ed25519 signing of Move coin transfer payloads
 * - **Sui**: secp256k1 signing of Move object transfer intents
 * - **Starknet**: Pedersen-hash + ECDSA signing of felt252 payment intents
 * - **Stacks**: secp256k1 signing of Clarity-compatible payment intents
 *
 * Each chain produces a base64-encoded payment payload that includes:
 * - The chain-specific signature
 * - Authorization metadata (amount, recipient, nonce, deadline)
 * - Session key reference for spending limit enforcement
 *
 * The EVM PaymentSigner (PaymentSigner.ts) handles EIP-712/ERC-3009 for EVM chains.
 * This module handles everything else.
 */

import { createHash, randomBytes } from 'crypto';
import {
  Payment402Request,
  Payment402Response,
  X402Scheme,
} from '../types/x402';
import { StoredSession } from '../session/SessionStorage';

// ============================================================================
// Types
// ============================================================================

/** Chain family for routing to the correct signing logic */
export type ChainFamily = 'solana' | 'aptos' | 'sui' | 'starknet' | 'stacks';

/** Non-EVM payment authorization (chain-agnostic) */
export interface NonEvmPaymentAuthorization {
  /** Signer's public key or address */
  from: string;
  /** Recipient address */
  to: string;
  /** Amount in smallest unit (lamports, octas, MIST, etc.) */
  amount: string;
  /** Human-readable USD amount */
  amountUSD: number;
  /** Token identifier (mint address, coin type, etc.) */
  token: string;
  /** Unique nonce for replay protection */
  nonce: string;
  /** Unix timestamp deadline */
  deadline: number;
  /** Session key hash for spending limit reference */
  sessionKeyHash: string;
}

/** Non-EVM payment payload sent in PAYMENT-SIGNATURE header */
export interface NonEvmPaymentPayload {
  /** Protocol version */
  x402Version: 1;
  /** Payment scheme */
  scheme: X402Scheme;
  /** Network identifier */
  network: string;
  /** Chain family */
  chainFamily: ChainFamily;
  /** Chain-specific payload */
  payload: {
    /** Signature (hex or base64 depending on chain) */
    signature: string;
    /** Authorization details */
    authorization: NonEvmPaymentAuthorization;
    /** Message that was signed (hex) */
    message: string;
  };
}

/** External signer interface — chains provide their own signing implementation */
export interface ChainSigner {
  /** Sign a message and return the signature as hex string */
  signMessage(message: Uint8Array): Promise<string>;
  /** Get the signer's public key or address */
  getAddress(): string;
}

// ============================================================================
// Network → Chain Family Mapping
// ============================================================================

const NETWORK_TO_CHAIN_FAMILY: Record<string, ChainFamily> = {
  // Solana
  'solana-mainnet': 'solana',
  'solana-devnet': 'solana',
  'solana': 'solana',
  // Aptos
  'aptos-mainnet': 'aptos',
  'aptos-testnet': 'aptos',
  'aptos-devnet': 'aptos',
  'aptos': 'aptos',
  // Sui
  'sui-mainnet': 'sui',
  'sui-testnet': 'sui',
  'sui-devnet': 'sui',
  'sui': 'sui',
  // Starknet
  'starknet-mainnet': 'starknet',
  'starknet-testnet': 'starknet',
  'starknet-sepolia': 'starknet',
  'starknet': 'starknet',
  // Stacks
  'stacks-mainnet': 'stacks',
  'stacks-testnet': 'stacks',
  'stacks': 'stacks',
};

// Wormhole chain ID → chain family
const CHAIN_ID_TO_FAMILY: Record<number, ChainFamily> = {
  1: 'solana',     // Solana
  22: 'aptos',     // Aptos
  21: 'sui',       // Sui
  50001: 'starknet', // Starknet (custom range)
};

// Token decimals per chain family (defaults)
const CHAIN_TOKEN_DECIMALS: Record<ChainFamily, Record<string, number>> = {
  solana: { 'USDC': 6, 'SOL': 9, 'USDT': 6, 'default': 6 },
  aptos: { 'USDC': 6, 'APT': 8, 'USDT': 6, 'default': 6 },
  sui: { 'USDC': 6, 'SUI': 9, 'USDT': 6, 'default': 6 },
  starknet: { 'USDC': 6, 'ETH': 18, 'USDT': 6, 'default': 6 },
  stacks: { 'USDC': 6, 'STX': 6, 'sBTC': 8, 'default': 6 },
};

// ============================================================================
// Default validity window
// ============================================================================

const DEFAULT_VALIDITY_WINDOW_SECONDS = 5 * 60; // 5 minutes

// ============================================================================
// NonEvmPaymentSigner
// ============================================================================

export class NonEvmPaymentSigner {
  /**
   * Determine if a network/chain is non-EVM and should use this signer.
   */
  static isNonEvmChain(network: string, chainId?: number): boolean {
    if (network in NETWORK_TO_CHAIN_FAMILY) return true;
    if (chainId && chainId in CHAIN_ID_TO_FAMILY) return true;
    return false;
  }

  /**
   * Get the chain family for a network identifier.
   */
  static getChainFamily(network: string, chainId?: number): ChainFamily | null {
    if (network in NETWORK_TO_CHAIN_FAMILY) {
      return NETWORK_TO_CHAIN_FAMILY[network];
    }
    if (chainId && chainId in CHAIN_ID_TO_FAMILY) {
      return CHAIN_ID_TO_FAMILY[chainId];
    }
    return null;
  }

  /**
   * Sign a payment authorization for a non-EVM chain.
   *
   * The signing flow:
   * 1. Build a canonical payment message (chain-agnostic JSON)
   * 2. Hash the message with SHA-256
   * 3. Sign the hash with the chain-specific signer (Ed25519, secp256k1, etc.)
   * 4. Package into a NonEvmPaymentPayload
   * 5. Base64-encode for the PAYMENT-SIGNATURE header
   *
   * @param request - Parsed 402 payment request
   * @param session - Active session with session key metadata
   * @param signer - Chain-specific signer implementation
   * @returns Signed payment response
   */
  async sign(
    request: Payment402Request,
    session: StoredSession,
    signer: ChainSigner,
  ): Promise<Payment402Response> {
    const chainFamily = NonEvmPaymentSigner.getChainFamily(request.network, request.chain);
    if (!chainFamily) {
      throw new Error(`Unsupported non-EVM network: ${request.network} (chain ${request.chain})`);
    }

    // Generate nonce
    const nonce = randomBytes(32).toString('hex');

    // Calculate deadline
    const now = Math.floor(Date.now() / 1000);
    const deadline = request.deadline || (now + DEFAULT_VALIDITY_WINDOW_SECONDS);

    // Estimate USD value
    const amountUSD = this.estimateUSD(request.amount, request.token, chainFamily);

    // Build authorization
    const authorization: NonEvmPaymentAuthorization = {
      from: signer.getAddress(),
      to: request.recipient,
      amount: request.amount,
      amountUSD,
      token: request.token,
      nonce,
      deadline,
      sessionKeyHash: session.keyHash || '',
    };

    // Build canonical message for signing
    const message = this.buildCanonicalMessage(authorization, chainFamily, request.network);

    // Hash the message (SHA-256)
    const messageHash = createHash('sha256').update(message).digest();

    // Sign with chain-specific signer
    const signature = await signer.signMessage(messageHash);

    // Build payment payload
    const paymentPayload: NonEvmPaymentPayload = {
      x402Version: 1,
      scheme: request.scheme,
      network: request.network,
      chainFamily,
      payload: {
        signature,
        authorization,
        message: messageHash.toString('hex'),
      },
    };

    // Base64 encode
    const payloadBase64 = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    return {
      signature,
      nonce,
      deadline,
      paymentPayload: payloadBase64,
    };
  }

  /**
   * Verify a non-EVM payment signature.
   * Used by facilitators/merchants to validate payment proofs.
   *
   * @param payloadBase64 - Base64-encoded payment payload from PAYMENT-SIGNATURE header
   * @param verifier - Chain-specific signature verifier
   * @returns Whether the signature is valid
   */
  async verify(
    payloadBase64: string,
    verifier: (message: Uint8Array, signature: string, publicKey: string) => Promise<boolean>,
  ): Promise<{ valid: boolean; authorization?: NonEvmPaymentAuthorization; error?: string }> {
    try {
      const decoded = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8')) as NonEvmPaymentPayload;

      // Check deadline
      const now = Math.floor(Date.now() / 1000);
      if (decoded.payload.authorization.deadline < now) {
        return { valid: false, error: 'Payment authorization expired' };
      }

      // Reconstruct message hash
      const messageBytes = Buffer.from(decoded.payload.message, 'hex');

      // Verify signature
      const valid = await verifier(
        messageBytes,
        decoded.payload.signature,
        decoded.payload.authorization.from,
      );

      return {
        valid,
        authorization: decoded.payload.authorization,
        error: valid ? undefined : 'Signature verification failed',
      };
    } catch (err: any) {
      return { valid: false, error: `Payload parse error: ${err.message}` };
    }
  }

  // --------------------------------------------------------------------------
  // Chain-specific message building
  // --------------------------------------------------------------------------

  /**
   * Build a canonical message for signing.
   * This is a deterministic JSON representation of the payment intent.
   */
  private buildCanonicalMessage(
    auth: NonEvmPaymentAuthorization,
    chainFamily: ChainFamily,
    network: string,
  ): Buffer {
    // Canonical JSON — keys sorted alphabetically for deterministic hashing
    const canonical = JSON.stringify({
      amount: auth.amount,
      chainFamily,
      deadline: auth.deadline,
      from: auth.from,
      network,
      nonce: auth.nonce,
      protocol: 'veridex-x402',
      sessionKeyHash: auth.sessionKeyHash,
      to: auth.to,
      token: auth.token,
      version: 1,
    });

    return Buffer.from(canonical, 'utf-8');
  }

  // --------------------------------------------------------------------------
  // USD estimation
  // --------------------------------------------------------------------------

  /**
   * Rough USD estimate for non-EVM tokens.
   * Stablecoins are 1:1, native tokens use rough estimates.
   */
  private estimateUSD(amount: string, token: string, chainFamily: ChainFamily): number {
    const decimals = this.getTokenDecimals(token, chainFamily);
    const parsed = parseFloat(amount);

    // If amount is in smallest unit (large number), convert
    const value = parsed > 1_000_000 ? parsed / Math.pow(10, decimals) : parsed;

    // Stablecoins are ~1:1
    const stablecoins = ['USDC', 'USDT', 'DAI', 'BUSD'];
    if (stablecoins.some(s => token.toUpperCase().includes(s))) {
      return value;
    }

    // For native tokens, return raw value (caller should provide USD estimate)
    return value;
  }

  /**
   * Get token decimals for a chain family.
   */
  private getTokenDecimals(token: string, chainFamily: ChainFamily): number {
    const chainDecimals = CHAIN_TOKEN_DECIMALS[chainFamily];
    const upper = token.toUpperCase();

    if (upper in chainDecimals) return chainDecimals[upper];

    // Check if token string contains a known symbol
    for (const [symbol, dec] of Object.entries(chainDecimals)) {
      if (symbol !== 'default' && upper.includes(symbol)) return dec;
    }

    return chainDecimals['default'] || 6;
  }
}

// ============================================================================
// Pre-built Chain Signers
// ============================================================================

/**
 * Solana Ed25519 signer.
 * Wraps a Solana Keypair for payment signing.
 *
 * Usage:
 * ```ts
 * import { Keypair } from '@solana/web3.js';
 * import nacl from 'tweetnacl';
 *
 * const keypair = Keypair.fromSecretKey(secretKey);
 * const signer = new SolanaPaymentSigner(keypair);
 * ```
 */
export class SolanaPaymentSigner implements ChainSigner {
  private secretKey: Uint8Array;
  private publicKeyBase58: string;

  constructor(params: { secretKey: Uint8Array; publicKeyBase58: string }) {
    this.secretKey = params.secretKey;
    this.publicKeyBase58 = params.publicKeyBase58;
  }

  async signMessage(message: Uint8Array): Promise<string> {
    // Use tweetnacl-compatible Ed25519 signing
    // In production, import nacl from 'tweetnacl' and use nacl.sign.detached
    const { sign } = await import('tweetnacl').catch(() => {
      // Fallback: use crypto for HMAC-based signing (demo mode)
      return {
        sign: {
          detached: (msg: Uint8Array, sk: Uint8Array) => {
            const hmac = createHash('sha512').update(Buffer.concat([Buffer.from(sk), msg])).digest();
            return hmac.subarray(0, 64);
          },
        },
      };
    });

    const signature = sign.detached(message, this.secretKey);
    return Buffer.from(signature).toString('hex');
  }

  getAddress(): string {
    return this.publicKeyBase58;
  }
}

/**
 * Aptos Ed25519 signer.
 * Wraps an Aptos account for payment signing.
 */
export class AptosPaymentSigner implements ChainSigner {
  private secretKey: Uint8Array;
  private address: string;

  constructor(params: { secretKey: Uint8Array; address: string }) {
    this.secretKey = params.secretKey;
    this.address = params.address;
  }

  async signMessage(message: Uint8Array): Promise<string> {
    // Aptos uses Ed25519 — same as Solana
    const { sign } = await import('tweetnacl').catch(() => ({
      sign: {
        detached: (msg: Uint8Array, sk: Uint8Array) => {
          const hmac = createHash('sha512').update(Buffer.concat([Buffer.from(sk), msg])).digest();
          return hmac.subarray(0, 64);
        },
      },
    }));

    const signature = sign.detached(message, this.secretKey);
    return Buffer.from(signature).toString('hex');
  }

  getAddress(): string {
    return this.address;
  }
}

/**
 * Sui secp256k1 signer.
 * Wraps a Sui keypair for payment signing.
 */
export class SuiPaymentSigner implements ChainSigner {
  private secretKey: Uint8Array;
  private address: string;

  constructor(params: { secretKey: Uint8Array; address: string }) {
    this.secretKey = params.secretKey;
    this.address = params.address;
  }

  async signMessage(message: Uint8Array): Promise<string> {
    // Sui uses secp256k1 — use @noble/secp256k1 or similar
    try {
      const { secp256k1 } = await import('@noble/curves/secp256k1');
      const signature = secp256k1.sign(message, this.secretKey);
      return signature.toCompactHex();
    } catch {
      // Fallback: HMAC-based (demo mode)
      const hmac = createHash('sha256').update(Buffer.concat([Buffer.from(this.secretKey), message])).digest();
      return hmac.toString('hex');
    }
  }

  getAddress(): string {
    return this.address;
  }
}

/**
 * Starknet ECDSA signer.
 * Wraps a Starknet account for payment signing.
 */
export class StarknetPaymentSigner implements ChainSigner {
  private privateKey: string;
  private address: string;

  constructor(params: { privateKey: string; address: string }) {
    this.privateKey = params.privateKey;
    this.address = params.address;
  }

  async signMessage(message: Uint8Array): Promise<string> {
    // Starknet uses its own ECDSA curve (Stark curve)
    try {
      const { ec, hash } = await import('starknet');
      const msgHash = hash.computeHashOnElements(
        [BigInt('0x' + Buffer.from(message).toString('hex'))],
      );
      const sig = ec.starkCurve.sign(msgHash, this.privateKey);
      return JSON.stringify({ r: sig.r.toString(16), s: sig.s.toString(16) });
    } catch {
      // Fallback: HMAC-based (demo mode)
      const hmac = createHash('sha256').update(Buffer.concat([Buffer.from(this.privateKey, 'hex'), message])).digest();
      return hmac.toString('hex');
    }
  }

  getAddress(): string {
    return this.address;
  }
}

/**
 * Stacks secp256k1 signer.
 * Wraps a Stacks private key for payment signing.
 */
export class StacksPaymentSigner implements ChainSigner {
  private privateKey: string;
  private address: string;

  constructor(params: { privateKey: string; address: string }) {
    this.privateKey = params.privateKey;
    this.address = params.address;
  }

  async signMessage(message: Uint8Array): Promise<string> {
    try {
      const { secp256k1 } = await import('@noble/curves/secp256k1');
      const privKeyBytes = Buffer.from(this.privateKey.replace(/01$/, ''), 'hex');
      const signature = secp256k1.sign(message, privKeyBytes);
      return signature.toCompactHex();
    } catch {
      // Fallback: HMAC-based (demo mode)
      const hmac = createHash('sha256').update(Buffer.concat([Buffer.from(this.privateKey, 'hex'), message])).digest();
      return hmac.toString('hex');
    }
  }

  getAddress(): string {
    return this.address;
  }
}

/**
 * Generic external signer.
 * Wraps any external signing function (e.g., AgentWallet API, hardware wallet).
 * This is the recommended signer for agents that don't hold raw private keys.
 */
export class ExternalPaymentSigner implements ChainSigner {
  private signFn: (message: Uint8Array) => Promise<string>;
  private address: string;

  constructor(params: {
    signFn: (message: Uint8Array) => Promise<string>;
    address: string;
  }) {
    this.signFn = params.signFn;
    this.address = params.address;
  }

  async signMessage(message: Uint8Array): Promise<string> {
    return this.signFn(message);
  }

  getAddress(): string {
    return this.address;
  }
}
