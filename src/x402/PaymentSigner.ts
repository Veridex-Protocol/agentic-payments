/**
 * x402 Payment Signer
 * 
 * Generates EIP-712 / ERC-3009 signatures for x402 payments.
 * 
 * ERC-3009 (transferWithAuthorization) allows gasless token transfers
 * where a signature authorizes a third party to transfer tokens.
 * 
 * Reference: https://eips.ethereum.org/EIPS/eip-3009
 */

import { ethers } from 'ethers';
import {
  Payment402Request,
  Payment402Response,
  PaymentPayload,
  ERC3009Authorization,
} from '../types/x402';
import { StoredSession } from '../session/SessionStorage';

// ERC-3009 type hash for transferWithAuthorization
const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'
  )
);

// Token decimals by symbol/common addresses
const TOKEN_DECIMALS: Record<string, number> = {
  'USDC': 6,
  'USDT': 6,
  'DAI': 18,
  'WETH': 18,
  // Common USDC addresses
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 6, // Base USDC
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 6, // Ethereum USDC
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': 6, // Arbitrum USDC
  '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85': 6, // Optimism USDC
};

// Default validity window (5 minutes)
const DEFAULT_VALIDITY_WINDOW_SECONDS = 5 * 60;

export class PaymentSigner {
  /**
   * Sign a payment authorization for an x402 request.
   * 
   * This creates an EIP-712 typed signature that authorizes the recipient
   * (or facilitator) to pull funds from the session key's vault.
   * 
   * @param request - Parsed 402 payment request
   * @param session - Active session with signing key
   * @returns Signed payment response with payload
   */
  async sign(
    request: Payment402Request,
    session: StoredSession
  ): Promise<Payment402Response> {
    // Create wallet from session key
    // Note: In production, the private key should be decrypted here
    const wallet = new ethers.Wallet(session.encryptedPrivateKey);

    // Generate cryptographically secure nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Calculate deadline with buffer
    const now = Math.floor(Date.now() / 1000);
    const deadline = request.deadline || (now + DEFAULT_VALIDITY_WINDOW_SECONDS);

    // Get token decimals
    const decimals = this.getTokenDecimals(request.token);

    // Parse amount - handle both raw and formatted amounts
    let valueInSmallestUnit: bigint;
    try {
      // Check if amount already looks like smallest unit (large number without decimal)
      if (request.amount.includes('.') || BigInt(request.amount) < BigInt(1e9)) {
        valueInSmallestUnit = ethers.parseUnits(request.amount, decimals);
      } else {
        valueInSmallestUnit = BigInt(request.amount);
      }
    } catch {
      // Fallback to parsing as formatted amount
      valueInSmallestUnit = ethers.parseUnits(request.amount, decimals);
    }

    // Build ERC-3009 authorization
    const authorization: ERC3009Authorization = {
      from: wallet.address,
      to: request.recipient,
      value: valueInSmallestUnit.toString(),
      validAfter: 0, // Valid immediately
      validBefore: deadline,
      nonce: nonce,
    };

    // EIP-712 domain - for x402 exact scheme on EVM
    const domain: ethers.TypedDataDomain = {
      name: 'x402',
      version: '1',
      chainId: this.wormholeToEvmChainId(request.chain),
      // verifyingContract would be the token contract
      // Not included as x402 uses a custom domain for payment protocol itself
    };

    // EIP-712 types for TransferWithAuthorization
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };

    // Value to sign
    const value = {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    };

    // Sign with EIP-712
    const signature = await wallet.signTypedData(domain, types, value);

    // Build x402 payment payload
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: request.scheme,
      network: request.network,
      payload: {
        signature,
        authorization,
      },
    };

    // Encode payload as base64
    const payloadBase64 = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

    return {
      signature,
      nonce,
      deadline,
      paymentPayload: payloadBase64,
    };
  }

  /**
   * Verify a payment signature (for testing/debugging).
   */
  verifySignature(
    signature: string,
    authorization: ERC3009Authorization,
    expectedSigner: string,
    chainId: number
  ): boolean {
    try {
      const domain: ethers.TypedDataDomain = {
        name: 'x402',
        version: '1',
        chainId,
      };

      const types = {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      };

      const recoveredAddress = ethers.verifyTypedData(domain, types, authorization, signature);
      return recoveredAddress.toLowerCase() === expectedSigner.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Get token decimals by address or symbol.
   */
  private getTokenDecimals(token: string): number {
    // Check direct match
    if (token in TOKEN_DECIMALS) {
      return TOKEN_DECIMALS[token];
    }

    // Check lowercase
    const lowerToken = token.toLowerCase();
    for (const [key, value] of Object.entries(TOKEN_DECIMALS)) {
      if (key.toLowerCase() === lowerToken) {
        return value;
      }
    }

    // Default to 6 for stablecoins (most x402 payments are USDC)
    console.warn(`[x402] Unknown token decimals for ${token}, defaulting to 6`);
    return 6;
  }

  /**
   * Map Wormhole chain ID to EVM chain ID.
   */
  private wormholeToEvmChainId(wormholeChainId: number): number {
    const mapping: Record<number, number> = {
      2: 1,        // Ethereum Mainnet
      30: 8453,    // Base Mainnet
      23: 42161,   // Arbitrum One
      24: 10,      // Optimism
      5: 137,      // Polygon
      6: 43114,    // Avalanche
      4: 56,       // BSC
      10002: 11155111, // Ethereum Sepolia
      10004: 84532,    // Base Sepolia
    };

    return mapping[wormholeChainId] || wormholeChainId;
  }
}
