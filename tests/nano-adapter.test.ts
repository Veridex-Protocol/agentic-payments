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
  InMemoryNanoOrderStore,
  type NanoOrder,
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

  it('converts without floating-point error', () => {
    expect(xnoToRaw('0.1')).toBe('100000000000000000000000000000');
    expect(xnoToRaw('0.000000000000000000000000000001')).toBe('1');
    expect(() => xnoToRaw('1e3')).toThrow();
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

describe('NanoFacilitatorAdapter verify/settle (mocked RPC, order-bound)', () => {
  let fetchMock: any;
  let nowMs: number;
  let store: InMemoryNanoOrderStore;
  let adapter: NanoFacilitatorAdapter;
  const recipient = 'nano_1recipientplaceh0000000000000000000000000000000000000000000000000000';
  const H1 = '1'.repeat(64);
  const H2 = '2'.repeat(64);

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    nowMs = 1_800_000_000_000;
    store = new InMemoryNanoOrderStore();
    adapter = new NanoFacilitatorAdapter({ store, clock: () => nowMs });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const issue = (ttlMs = 60_000) =>
    adapter.issueOrder({ recipient, priceRaw: '1000000000000000000000000000', ttlMs });

  function blockFor(order: NanoOrder, over: Record<string, any> = {}) {
    return {
      hash: 'HASH',
      confirmed: 'true',
      subtype: 'send',
      amount: order.amountRaw,
      local_timestamp: String(Math.floor((order.issuedAtMs + 1000) / 1000)),
      contents: { type: 'state', link_as_account: order.payTo },
      ...over,
    };
  }

  function stub(reply: Record<string, any>) {
    fetchMock.mockResolvedValue({ ok: true, json: async () => reply });
  }

  const makeReq = (order: NanoOrder, network = 'nano:mainnet'): Payment402Request => ({
    amount: order.amountRaw,
    token: 'XNO',
    recipient: order.payTo,
    chain: 0,
    network,
    scheme: 'exact',
    original: {} as any,
  });

  const makeResp = (blockHash: string, orderId?: string): Payment402Response => ({
    signature: blockHash,
    nonce: '',
    deadline: 0,
    paymentPayload: JSON.stringify({ payload: { blockHash, ...(orderId ? { orderId } : {}) } }),
  });

  it('issues an opaque order id and a tagged amount above the price', async () => {
    const order = await issue();
    expect(order.orderId).toMatch(/^[0-9a-f]{32}$/);
    expect(BigInt(order.amountRaw)).toBeGreaterThan(10n ** 27n);
    expect(BigInt(order.amountRaw)).toBeLessThan(10n ** 27n + 1_000_000n);
  });

  it('never gives two open orders the same amount', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add((await issue()).amountRaw);
    expect(seen.size).toBe(40);
  });

  it('verifies a confirmed send that pays this order, idempotently', async () => {
    const order = await issue();
    stub(blockFor(order));
    expect(await adapter.verify(makeReq(order), makeResp(H1, order.orderId))).toBe(true);
    expect(await adapter.verify(makeReq(order), makeResp(H1, order.orderId))).toBe(true);
  });

  it('reads the amount from the top level of block_info, not from contents', async () => {
    const order = await issue();
    stub(blockFor(order, { contents: { type: 'state', link_as_account: order.payTo, amount: order.amountRaw }, amount: '1' }));
    expect(await adapter.verify(makeReq(order), makeResp(H1, order.orderId))).toBe(false);
  });

  it('rejects a payload with no orderId (a block hash alone is no proof)', async () => {
    const order = await issue();
    stub(blockFor(order));
    expect(await adapter.verify(makeReq(order), makeResp(H1))).toBe(false);
  });

  it('rejects an unknown order id', async () => {
    const order = await issue();
    stub(blockFor(order));
    expect(await adapter.verify(makeReq(order), makeResp(H1, 'f'.repeat(32)))).toBe(false);
  });

  it('rejects a block that pays a different order of the same price', async () => {
    const a = await issue();
    const b = await issue();
    stub(blockFor(b));
    expect(await adapter.verify(makeReq(a), makeResp(H1, a.orderId))).toBe(false);
  });

  it('refuses a request whose amount or recipient differs from the order', async () => {
    const order = await issue();
    stub(blockFor(order));
    expect(await adapter.verify({ ...makeReq(order), amount: '1' }, makeResp(H1, order.orderId))).toBe(false);
    expect(await adapter.verify({ ...makeReq(order), recipient: 'nano_other' }, makeResp(H1, order.orderId))).toBe(false);
  });

  it('rejects wrong amount, missing amount, wrong or missing recipient', async () => {
    const order = await issue();
    for (const reply of [
      blockFor(order, { amount: '1' }),
      blockFor(order, { amount: undefined }),
      blockFor(order, { contents: { type: 'state', link_as_account: 'nano_other' } }),
      blockFor(order, { contents: { type: 'state' } }),
    ]) {
      stub(reply);
      expect(await adapter.verify(makeReq(order), makeResp(H1, order.orderId))).toBe(false);
    }
  });

  it('rejects unconfirmed, non-send and errored blocks', async () => {
    const order = await issue();
    for (const reply of [
      blockFor(order, { confirmed: 'false' }),
      blockFor(order, { confirmed: undefined }),
      blockFor(order, { subtype: 'receive' }),
      { error: 'Block not found' },
    ]) {
      stub(reply);
      expect(await adapter.verify(makeReq(order), makeResp(H1, order.orderId))).toBe(false);
    }
  });

  it('claims blockHash -> orderId once: a hash cannot pay a second order', async () => {
    const a = await issue();
    const b = await issue();
    stub(blockFor(a));
    expect(await adapter.verify(makeReq(a), makeResp(H1, a.orderId))).toBe(true);
    stub(blockFor(b));
    expect(await adapter.verify(makeReq(b), makeResp(H1, b.orderId))).toBe(false);
  });

  it('refuses a second block for an order that is already paid', async () => {
    const order = await issue();
    stub(blockFor(order));
    expect(await adapter.verify(makeReq(order), makeResp(H1, order.orderId))).toBe(true);
    expect(await adapter.verify(makeReq(order), makeResp(H2, order.orderId))).toBe(false);
  });

  it('treats hash case as the same hash', async () => {
    const a = await issue();
    const b = await issue();
    stub(blockFor(a));
    expect(await adapter.verify(makeReq(a), makeResp('ab'.repeat(32), a.orderId))).toBe(true);
    stub(blockFor(b));
    expect(await adapter.verify(makeReq(b), makeResp('AB'.repeat(32), b.orderId))).toBe(false);
  });

  it('survives a restart when the store is shared (claims live in the store)', async () => {
    const a = await issue();
    stub(blockFor(a));
    expect(await adapter.verify(makeReq(a), makeResp(H1, a.orderId))).toBe(true);
    const restarted = new NanoFacilitatorAdapter({ store, clock: () => nowMs });
    const b = await restarted.issueOrder({ recipient, priceRaw: '1000000000000000000000000000' });
    stub(blockFor(b));
    expect(await restarted.verify(makeReq(b), makeResp(H1, b.orderId))).toBe(false);
  });

  it('refuses a block made after expiry or before the order, and an expired order', async () => {
    const order = await issue(60_000);
    const late = String(Math.floor((order.expiresAtMs + 120_000) / 1000));
    const early = String(Math.floor((order.issuedAtMs - 120_000) / 1000));
    for (const ts of [late, early, '0', undefined]) {
      stub(blockFor(order, { local_timestamp: ts }));
      expect(await adapter.verify(makeReq(order), makeResp(H1, order.orderId))).toBe(false);
    }
    stub(blockFor(order));
    nowMs = order.expiresAtMs + 1;
    expect(await adapter.verify(makeReq(order), makeResp(H1, order.orderId))).toBe(false);
  });

  it('refuses a malformed block hash before any lookup', async () => {
    const order = await issue();
    stub(blockFor(order));
    for (const bad of ['BLOCKHASH', 'g'.repeat(64), '1'.repeat(63)]) {
      expect(await adapter.verify(makeReq(order), makeResp(bad, order.orderId))).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a plain-HTTP non-loopback RPC url, allows https and loopback', () => {
    expect(() => new NanoFacilitatorAdapter({ rpcUrl: 'http://rpc.example.com' })).toThrow(/https/);
    expect(() => new NanoFacilitatorAdapter({ rpcUrl: 'https://rpc.example.com' })).not.toThrow();
    expect(() => new NanoFacilitatorAdapter({ rpcUrl: 'http://127.0.0.1:7076' })).not.toThrow();
  });

  it('bounds the node lookup: timeout signal and response size', async () => {
    const order = await issue();
    stub(blockFor(order));
    await adapter.verify(makeReq(order), makeResp(H1, order.orderId));
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
    fetchMock.mockResolvedValue({ ok: true, headers: { get: () => String(10 * 1024 * 1024) }, json: async () => blockFor(order) });
    const other = await issue();
    expect(await adapter.verify(makeReq(other), makeResp(H2, other.orderId))).toBe(false);
    fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ pad: 'x'.repeat(200_000) }) });
    expect(await adapter.verify(makeReq(other), makeResp(H2, other.orderId))).toBe(false);
  });

  it('settles a verified order and returns the block hash as the transaction hash', async () => {
    const order = await issue();
    stub(blockFor(order));
    const settled = await adapter.settle(makeReq(order), makeResp(H1, order.orderId));
    expect(settled.success).toBe(true);
    expect(settled.transactionHash).toBe(H1);
    expect(settled.network).toBe('nano:mainnet');
  });

  it('settle refuses an unconfirmed, unbound or replayed block (it does not trust verify)', async () => {
    const order = await issue();
    stub(blockFor(order, { confirmed: 'false' }));
    await expect(adapter.settle(makeReq(order), makeResp(H1, order.orderId))).rejects.toThrow(/rejected/);
    stub(blockFor(order));
    await expect(adapter.settle(makeReq(order), makeResp(H1))).rejects.toThrow(/orderId/);
    const other = await issue();
    await adapter.settle(makeReq(order), makeResp(H1, order.orderId));
    stub(blockFor(other));
    await expect(adapter.settle(makeReq(other), makeResp(H1, other.orderId))).rejects.toThrow(/claimed/);
  });

  it('throws a typed error when settle has no block hash', async () => {
    await expect(adapter.settle(makeReq(await issue()), { signature: '', nonce: '', deadline: 0, paymentPayload: '' }))
      .rejects.toThrow(/no block hash/);
  });

  it('standalone verifyNanoPayment needs the order id and its store', async () => {
    const order = await issue();
    stub(blockFor(order));
    const requirements = { network: 'nano:mainnet', maxAmountRequired: order.amountRaw, payTo: order.payTo, orderId: order.orderId };
    expect((await verifyNanoPayment(H1, requirements, { store })).isValid).toBe(true);
    expect((await verifyNanoPayment(H1, { ...requirements, orderId: 'f'.repeat(32) }, { store })).isValid).toBe(false);
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
