/**
 * ProtectedRpc tests — bring-your-own MEV-protected RPC seam (Gap 4).
 */

import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  resolveProtectedRpc,
  resolveProtectedProvider,
  broadcastProtected,
  type ProtectedRpcConfig,
} from '../src/protected/ProtectedRpc';

const FALLBACK = 'https://public-rpc.example';

describe('resolveProtectedRpc', () => {
  it('returns undefined when no resolver is configured', () => {
    expect(resolveProtectedRpc(undefined, 1)).toBeUndefined();
  });

  it('resolves from a per-chain map', () => {
    const cfg: ProtectedRpcConfig = { rpcUrl: 'https://flashbots.example' };
    expect(resolveProtectedRpc({ 1: cfg }, 1)).toBe(cfg);
    expect(resolveProtectedRpc({ 1: cfg }, 2)).toBeUndefined();
  });

  it('resolves from a function resolver', () => {
    const cfg: ProtectedRpcConfig = { label: 'mev-blocker' };
    const resolver = (chain: number) => (chain === 10 ? cfg : undefined);
    expect(resolveProtectedRpc(resolver, 10)).toBe(cfg);
    expect(resolveProtectedRpc(resolver, 11)).toBeUndefined();
  });
});

describe('resolveProtectedProvider', () => {
  it('uses a supplied provider verbatim', () => {
    const provider = new ethers.JsonRpcProvider(FALLBACK);
    expect(resolveProtectedProvider({ provider }, FALLBACK)).toBe(provider);
  });

  it('builds a provider from a protected rpcUrl', () => {
    const p = resolveProtectedProvider({ rpcUrl: 'https://flashbots.example' }, FALLBACK);
    expect(p).toBeInstanceOf(ethers.JsonRpcProvider);
    expect(p._getConnection().url).toBe('https://flashbots.example');
  });

  it('falls back to the public RPC when nothing is configured', () => {
    const p = resolveProtectedProvider(undefined, FALLBACK);
    expect(p._getConnection().url).toBe(FALLBACK);
  });
});

describe('broadcastProtected', () => {
  it('broadcasts via the signer when no submit hook is configured', async () => {
    const sendTransaction = vi.fn(async () => ({ hash: '0xpublic' }) as ethers.TransactionResponse);
    const signer = { sendTransaction } as unknown as ethers.Wallet;

    const result = await broadcastProtected(signer, { to: '0xabc', value: 1n }, undefined, {
      chain: 1,
    });

    expect(result.hash).toBe('0xpublic');
    expect(result.response).toBeDefined();
    expect(sendTransaction).toHaveBeenCalledOnce();
  });

  it('signs locally and submits via the relay hook (never hits the public mempool)', async () => {
    const populateTransaction = vi.fn(async (tx) => tx);
    const signTransaction = vi.fn(async () => '0xsignedraw');
    const sendTransaction = vi.fn();
    const signer = {
      populateTransaction,
      signTransaction,
      sendTransaction,
    } as unknown as ethers.Wallet;

    const submit = vi.fn(async (raw: string) => {
      expect(raw).toBe('0xsignedraw');
      return '0xrelayhash';
    });
    const config: ProtectedRpcConfig = { submit, label: 'flashbots-protect' };

    const result = await broadcastProtected(signer, { to: '0xabc', value: 1n }, config, {
      chain: 1,
    });

    expect(result.hash).toBe('0xrelayhash');
    expect(result.response).toBeUndefined();
    expect(signTransaction).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    // Critically: the signed tx was NOT broadcast to the public provider.
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
