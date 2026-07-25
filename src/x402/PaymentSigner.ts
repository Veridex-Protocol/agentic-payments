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
import type {
  Payment402Request,
  Payment402Response,
  PaymentPayload,
  ERC3009Authorization,
} from '../types/x402';
import type { StoredSession } from '../session/SessionStorage';
import { resolveEvmChainId, resolveToken } from './tokens';

// ERC-3009 type hash for transferWithAuthorization
const _TRANSFER_WITH_AUTHORIZATION_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'
  )
);

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
    session: StoredSession,
    preDecryptedWallet?: ethers.Wallet
  ): Promise<Payment402Response> {
    // Use pre-decrypted wallet if available (from ProtocolContext.signerWallet),
    // otherwise fall back to treating encryptedPrivateKey as raw hex (legacy/dev mode)
    const wallet = preDecryptedWallet ?? new ethers.Wallet(session.encryptedPrivateKey);

    // Generate cryptographically secure nonce
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // Calculate deadline with buffer
    const now = Math.floor(Date.now() / 1000);
    const deadline = request.deadline || (now + DEFAULT_VALIDITY_WINDOW_SECONDS);

    // Resolve the settlement token. `network` wins over the Wormhole chain id because
    // Wormhole gives BSC mainnet and BSC testnet the same id (4). Unknown tokens throw:
    // guessing an address or a decimals scale here is how you misprice by 10^12.
    const evmChainId = resolveEvmChainId(request.network, request.chain);
    const tokenInfo = resolveToken(request.token, evmChainId);
    const tokenAddress = tokenInfo.address;
    const decimals = tokenInfo.decimals;

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

}
