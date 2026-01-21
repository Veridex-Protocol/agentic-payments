/**
 * @packageDocumentation
 * @module PaymentSigner
 * @description
 * Cryptographic engine for x402 payment authorization.
 * 
 * This module is responsible for producing the correct cryptographic proof for a payment
 * request. It supports:
 * - **EIP-712**: Typed structured data signing for EVM chains (ERC-3009).
 * - **Key Management**: securely loading encrypted session keys for signing.
 * - **Nonce Generation**: ensuring replay protection for payment payloads.
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
  '0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0': 6, // Cronos Testnet devUSDC.e
  '0xf951eC28187D9E5Ca673Da8FE6757E6f0Be5F77C': 6, // Cronos Mainnet USDC.e
  '0x7A7754A2089df825801A0a8d95a9801928bFb22A': 6, // Ethereum Sepolia USDC
};

// Token symbol to address mapping for x402 (default to Base USDC)
const TOKEN_SYMBOL_TO_ADDRESS: Record<string, Record<number, string>> = {
  'USDC': {
    2: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',   // Ethereum Mainnet
    30: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // Base Mainnet
    23: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',  // Arbitrum One
    24: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',  // Optimism
    25: '0xf951eC28187D9E5Ca673Da8FE6757E6f0Be5F77C',  // Cronos Mainnet
    10002: '0x7A7754A2089df825801A0a8d95a9801928bFb22A', // Ethereum Sepolia
    10025: '0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0', // Cronos Testnet
  },
};

// Default token address when chain-specific address is not found
const DEFAULT_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base USDC

// Token metadata for EIP-712 domains
const TOKEN_METADATA: Record<string, { name: string; version: string }> = {
  '0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0': { name: 'Bridged USDC (Stargate)', version: '1' }, // Cronos Testnet
  '0xf951eC28187D9E5Ca673Da8FE6757E6f0Be5F77C': { name: 'Bridged USDC (Stargate)', version: '1' }, // Cronos Mainnet
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

    // Resolve token address from symbol if needed
    const tokenAddress = this.resolveTokenAddress(request.token, request.chain);

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
    const tokenMetadata = TOKEN_METADATA[tokenAddress.toLowerCase()] || { name: 'x402', version: '1' };
    const evmChainId = this.wormholeToEvmChainId(request.chain);

    const domain: ethers.TypedDataDomain = {
      name: tokenMetadata.name,
      version: tokenMetadata.version,
      chainId: evmChainId,
      verifyingContract: tokenAddress,
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
   * 
   * @param signature - The EIP-712 signature to verify
   * @param authorization - The ERC-3009 authorization data
   * @param expectedSigner - Expected signer address
   * @param chainId - EVM chain ID
   * @param tokenAddress - Optional token contract address used as verifyingContract
   */
  verifySignature(
    signature: string,
    authorization: ERC3009Authorization,
    expectedSigner: string,
    chainId: number,
    tokenAddress?: string
  ): boolean {
    try {
      // Get token metadata if available
      const tokenMetadata = tokenAddress
        ? (TOKEN_METADATA[tokenAddress.toLowerCase()] || { name: 'x402', version: '1' })
        : { name: 'x402', version: '1' };

      const domain: ethers.TypedDataDomain = {
        name: tokenMetadata.name,
        version: tokenMetadata.version,
        chainId,
        ...(tokenAddress && { verifyingContract: tokenAddress }),
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
    if (!token.startsWith('0x')) {
      // This is a symbol, not an address - don't warn for known symbols
      return 6;
    }
    console.warn(`[x402] Unknown token decimals for ${token}, defaulting to 6`);
    return 6;
  }

  /**
   * Resolve token symbol to address for the given chain.
   * If already an address, returns it as-is.
   */
  private resolveTokenAddress(token: string, wormholeChainId: number): string {
    // If it's already an address, return it
    if (token.startsWith('0x') && token.length === 42) {
      return token;
    }

    // Look up the token symbol
    const upperSymbol = token.toUpperCase();
    const chainAddresses = TOKEN_SYMBOL_TO_ADDRESS[upperSymbol];
    if (chainAddresses) {
      const address = chainAddresses[wormholeChainId];
      if (address) {
        return address;
      }
    }

    // Default to Base USDC for unknown symbols (for testing)
    console.warn(`[x402] Unknown token symbol ${token} for chain ${wormholeChainId}, using default USDC address`);
    return DEFAULT_USDC_ADDRESS;
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
      25: 25,      // Cronos Mainnet
      10002: 11155111, // Ethereum Sepolia
      10004: 84532,    // Base Sepolia
      10025: 338,      // Cronos Testnet
    };

    return mapping[wormholeChainId] || wormholeChainId;
  }
}
