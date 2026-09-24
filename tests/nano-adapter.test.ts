/**
 * @packageDocumentation
 * @module NanoFacilitatorAdapterTest
 * @description
 * Tests for the Nano (XNO) x402 facilitator adapter: amount math, network
 * parsing, capability reporting, and verify/settle logic against a mocked
 * Nano node RPC (no live node, no funds moved).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NanoFacilitatorAdapter,
  xnoToRaw,
  rawToXno,
  toNanoNetwork,
  isNanoNetwork,
  buildNanoPaymentRequirements,
  verifyNanoPayment,
  NANO_RAW_PER_XNO,
} from '../src/x402/adapters/NanoFacilitatorAdapter';
import type { Payment402Request, Payment402Response } from '../src/types/x402';

// --- Unit: amount math ---

describe('NanoFacilitatorAdapter amount math', () => {
  it('converts whole XNO to raw (1 XNO = 10^30 raw)', () => {
    expect(xnoToRaw('1')).toBe('1000000000000000000000000000000');
  });

  it('converts a fractional XNO amount to raw', () => {
    expect(xnoToRaw('0.001')).toBe('1000000000000000000000000000');
  });

  it('round-trips raw back to XNO', () => {
    expect(rawToXno(NANO_RAW_PER_XNO.toString())).toBe('1');
  });

  it('round-trips a small fraction back to XNO', () => {
    expect(rawToXno(xnoToRaw('0.001'))).toBe('0.001');
  });
});

// --- Unit: network parsing ---

describe('NanoFacilitatorAdapter network handling', () => {
  it('recognises nano:mainnet', () => {
    expect(isNanoNetwork('nano:mainnet')).toBe(true);
    expect(toNanoNetwork('mainnet')).toBe('nano:mainnet');
  });

  it('recognises the bare mainnet alias', () => {
    expect(isNanoNetwork('mainnet')).toBe(true);
  });

  it('rejects a non-Nano network', () => {
    expect(isNanoNetwork('stellar:pubnet')).toBe(false);
    expect(isNanoNetwork('base-mainnet')).toBe(false);
  });
});

// --- Adapter: capabilities ---

describe('NanoFacilitatorAdapter capabilities', () => {
  it('reports XNO on nano:mainnet with exact/upto schemes', () => {
    const adapter = new NanoFacilitatorAdapter();
    expect(adapter.canHandle({ amount: '1', token: 'XNO', recipient: 'x', chain: 0, network: 'nano:mainnet', scheme: 'exact' } as Payment402Request)).toBe(true);
    expect(adapter.canHandle({ amount: '1', token: 'XNO', recipient: 'x', chain: 0, network: 'nano:mainnet', scheme: 'upto' } as Payment402Request)).toBe(true);
  });

  it('does not handle a non-Nano network', () => {
    const adapter = new NanoFacilitatorAdapter();
    expect(adapter.canHandle({ amount: '1', token: 'USDC', recipient: 'x', chain: 0, network: 'stellar:pubnet', scheme: 'exact' } as Payment402Request)).toBe(false);
  });

  it('reports the correct capabilities', () => {
    const adapter = new NanoFacilitatorAdapter();
    const caps = adapter.getCapabilities();
    expect(caps.assets).toContain('XNO');
    expect(caps.network).toBe('nano:mainnet');
    expect(caps.schemes).toContain('exact_nano');
  });
});

// --- Adapter: verify/settle against a mocked node ---

describe('NanoFacilitatorAdapter verify/settle (mocked RPC)', () => {
  let fetchMock: any;
  const recipient = 'nano_1recipientplaceh0000000000000000000000000000000000000000000000000000';

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBlock(contents: Record<string, any>, opts: Record<string, any> = {}) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        hash: 'HASH',
        confirmed: opts.confirmed ?? true,
        contents,
        ...(opts.error ? { error: opts.error } : {}),
      }),
    });
  }

  const makeReq = (network = 'nano:mainnet'): Payment402Request => ({
    amount: '1000000000000000000000000000', // 0.001 XNO
    token: 'XNO',
    recipient,
    chain: 0,
    network,
    scheme: 'exact',
    original: {} as any,
  });

  const makeResp = (blockHash = 'BLOCKHASH'): Payment402Response => ({
    signature: blockHash,
    nonce: '',
    deadline: 0,
    paymentPayload: JSON.stringify({ payload: { blockHash } }),
  });

  it('verifies a valid on-ledger block that pays the recipient the required amount', async () => {
    stubBlock({ link_as_account: recipient, amount: '1000000000000000000000000000' });
    const adapter = new NanoFacilitatorAdapter();
    const ok = await adapter.verify(makeReq(), makeResp());
    expect(ok).toBe(true);
  });

  it('rejects when the block amount does not match', async () => {
    stubBlock({ link_as_account: recipient, amount: '1' }); // wrong amount
    const adapter = new NanoFacilitatorAdapter();
    const ok = await adapter.verify(makeReq(), makeResp());
    expect(ok).toBe(false);
  });

  it('rejects when the block recipient does not match', async () => {
    stubBlock({ link_as_account: 'nano_other000000000000000000000000000000000000000000000000000', amount: '1000000000000000000000000000' });
    const adapter = new NanoFacilitatorAdapter();
    const ok = await adapter.verify(makeReq(), makeResp());
    expect(ok).toBe(false);
  });

  it('rejects when the node reports no block', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'Block not found' }) });
    const adapter = new NanoFacilitatorAdapter();
    const ok = await adapter.verify(makeReq(), makeResp());
    expect(ok).toBe(false);
  });

  it('settles and returns the block hash as the transaction hash', async () => {
    stubBlock({ link_as_account: recipient, amount: '1000000000000000000000000000' });
    const adapter = new NanoFacilitatorAdapter();
    const settled = await adapter.settle(makeReq(), makeResp('BLOCKHASH'));
    expect(settled.success).toBe(true);
    expect(settled.transactionHash).toBe('BLOCKHASH');
    expect(settled.network).toBe('nano:mainnet');
  });

  it('throws a typed error when settle has no block hash', async () => {
    const adapter = new NanoFacilitatorAdapter();
    await expect(adapter.settle(makeReq(), { signature: '', nonce: '', deadline: 0, paymentPayload: '' }))
      .rejects.toThrow(/no block hash/);
  });
});

// --- Standalone helper: buildNanoPaymentRequirements ---

describe('buildNanoPaymentRequirements', () => {
  it('builds exact requirements on nano:mainnet with raw amount', () => {
    const req = buildNanoPaymentRequirements({ priceXNO: '0.001', recipientAddress: 'nano_x' });
    expect(req.network).toBe('nano:mainnet');
    expect(req.asset).toBe('XNO');
    expect(req.maxAmountRequired).toBe('1000000000000000000000000000');
    expect(req.scheme).toBe('exact');
  });
});
