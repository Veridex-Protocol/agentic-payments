import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { VeridexGoatWalletWrapper, PolicyDenialError } from '../src/wallets/VeridexGoatWalletWrapper.js';

describe('VeridexGoatWalletWrapper', () => {
  const sessionWallet = ethers.Wallet.createRandom();

  const mockUnderlyingProvider = {
    sendTransaction: vi.fn().mockResolvedValue({
      hash: '0x5d8e2c1a9f4b7306e2a5c1d9b3f80547a6e9c2b1d3f4a80c5e7b1d9a3f60528e',
    }),
    signMessage: vi.fn().mockResolvedValue('0xsignature'),
    signTypedData: vi.fn().mockResolvedValue('0xtypedsignature'),
  };

  it('should evaluate policy in-path and emit signed evidence on allowed transactions', async () => {
    const wrapper = new VeridexGoatWalletWrapper(mockUnderlyingProvider, {
      agentId: 'erc8004:30:1042',
      sessionSigner: sessionWallet,
      policyEngine: {
        evaluate: async () => ({
          verdict: 'pass',
          riskScore: 12,
          reasons: ['All checks passed'],
          checks: [],
          mandateVersion: '1.2.0',
          evaluatedAt: Date.now(),
        }),
      },
    });

    const result = await wrapper.sendTransaction({
      to: '0x9A7c3f5B2e8D14a6C0f9E7b2D5a8F1c3B4d6E0a2',
      value: '2500000',
      asset: 'USDC',
      chain: 30,
    });

    expect(result.txResult.hash).toBe('0x5d8e2c1a9f4b7306e2a5c1d9b3f80547a6e9c2b1d3f4a80c5e7b1d9a3f60528e');
    expect(result.traceHash).toBeDefined();
    expect(result.signature).toBeDefined();
    expect(mockUnderlyingProvider.sendTransaction).toHaveBeenCalledOnce();
  });

  it('should block transactions pre-signature and throw PolicyDenialError on policy block', async () => {
    const mockBlockProvider = {
      sendTransaction: vi.fn(),
    };

    const wrapper = new VeridexGoatWalletWrapper(mockBlockProvider, {
      agentId: 'erc8004:30:1042',
      sessionSigner: sessionWallet,
      policyEngine: {
        evaluate: async () => ({
          verdict: 'block',
          riskScore: 90,
          reasons: ['Spending limit exceeded'],
          checks: [],
          mandateVersion: '1.2.0',
          evaluatedAt: Date.now(),
        }),
      },
    });

    await expect(
      wrapper.sendTransaction({
        to: '0xSanctionedAddress',
        value: '1000000000',
        asset: 'USDC',
        chain: 30,
      })
    ).rejects.toThrow(PolicyDenialError);

    // Verify key touch was 0% (sendTransaction on underlying provider was not called)
    expect(mockBlockProvider.sendTransaction).not.toHaveBeenCalled();
  });
});
