/**
 * Regression tests for issue #3: settlement must succeed (and meet the
 * settlement-success contract) before any protected action. Fail closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { veridexPaywall, createPaywallHandler } from '../src/middleware/veridexPaywall';
import { withPaywall } from '../src/middleware/nextAppRouter';
import { validateSettlementResponse } from '../src/middleware/settlementContract';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const RECIPIENT = '0x1234567890abcdef1234567890abcdef12345678';
const TX_HASH = '0x' + 'ab'.repeat(32);

function req(headers: Record<string, string> = {}): any {
  return { headers: { host: 'api.example.com', ...headers }, protocol: 'https' };
}

function res(): any {
  const r: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    status(code: number) { r.statusCode = code; return r; },
    setHeader(k: string, v: string) { r.headers[k] = v; return r; },
    json(d: any) { r.body = d; return r; },
  };
  return r;
}

function jsonResponse(body: any, status = 200): any {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** A structurally valid x402 payload so the built-in verifier reaches the facilitator. */
function x402Payload(): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2, scheme: 'exact', network: 'base-mainnet',
    payload: {
      signature: '0xabc',
      authorization: {
        from: '0x' + '11'.repeat(20), to: RECIPIENT, value: '1000000', validAfter: 0,
        validBefore: Math.floor(Date.now() / 1000) + 300, nonce: '0x' + '22'.repeat(32),
      },
    },
  })).toString('base64');
}

const verifyOk = () => vi.fn().mockResolvedValue(true);

/** Settlement outcomes that must withhold access. */
const FAILING_SETTLEMENTS: Array<[string, () => any]> = [
  ['HTTP 500', () => Promise.resolve(jsonResponse({ error: 'boom' }, 500))],
  ['facilitator unreachable', () => Promise.reject(new TypeError('fetch failed'))],
  ['explicit rejection (success: false)', () => Promise.resolve(jsonResponse({ success: false, errorReason: 'insufficient_funds' }))],
  ['HTTP 200 with empty body (HTTP-only success)', () => Promise.resolve(jsonResponse({}))],
  ['success: true but no transaction hash', () => Promise.resolve(jsonResponse({ success: true }))],
  ['success as truthy string', () => Promise.resolve(jsonResponse({ success: 'true', transaction: TX_HASH }))],
  ['malformed EVM tx hash', () => Promise.resolve(jsonResponse({ success: true, transaction: '0x1234' }))],
  ['pending / indeterminate status', () => Promise.resolve(jsonResponse({ success: true, transaction: TX_HASH, status: 'pending' }))],
  ['success with errorReason', () => Promise.resolve(jsonResponse({ success: true, transaction: TX_HASH, errorReason: 'reverted' }))],
  ['non-JSON body', () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } })],
];

/** fetch mock that never resolves until aborted — exercises the settlement timeout. */
function hangUntilAborted(_url: string, init: any): Promise<any> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
  });
}

beforeEach(() => { mockFetch.mockReset(); });

// ---------------------------------------------------------------------------

describe('veridexPaywall — settlement is blocking and fail-closed', () => {
  it('grants access only after settlement succeeds, with evidence attached', async () => {
    let releaseSettle!: (v: any) => void;
    mockFetch.mockImplementationOnce(() => new Promise(r => { releaseSettle = r; }));

    const mw = veridexPaywall({ amount: '1', recipient: RECIPIENT, verifyPayment: verifyOk() });
    const rq = req({ 'payment-signature': 'p' });
    const next = vi.fn();
    const done = mw(rq, res(), next);

    // Settlement in flight: no access yet, not marked verified
    await new Promise(r => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledWith(expect.stringMatching(/\/settle$/), expect.anything());
    expect(next).not.toHaveBeenCalled();
    expect(rq.veridexPayment).toBeUndefined();

    releaseSettle(jsonResponse({ success: true, transaction: TX_HASH, network: 'base-mainnet', payer: '0xpayer' }));
    await done;

    expect(next).toHaveBeenCalledTimes(1);
    expect(rq.veridexPayment.verified).toBe(true);
    expect(rq.veridexPayment.settlement).toEqual({ txHash: TX_HASH, network: 'base-mainnet', payer: '0xpayer' });
  });

  it.each(FAILING_SETTLEMENTS)('withholds access on %s', async (_label, impl) => {
    mockFetch.mockImplementationOnce(impl);
    const mw = veridexPaywall({ amount: '1', recipient: RECIPIENT, verifyPayment: verifyOk() });
    const rq = req({ 'payment-signature': 'p' });
    const rs = res();
    const next = vi.fn();

    await mw(rq, rs, next);

    expect(next).not.toHaveBeenCalled();
    expect(rq.veridexPayment).toBeUndefined();
    expect(rs.statusCode).toBe(402);
    expect(rs.body.error).toBe('Payment settlement failed');
  });

  it('withholds access when settlement times out', async () => {
    mockFetch.mockImplementationOnce(hangUntilAborted);
    const mw = veridexPaywall({ amount: '1', recipient: RECIPIENT, verifyPayment: verifyOk(), settlementTimeoutMs: 20 });
    const rq = req({ 'payment-signature': 'p' });
    const rs = res();
    const next = vi.fn();

    await mw(rq, rs, next);

    expect(next).not.toHaveBeenCalled();
    expect(rq.veridexPayment).toBeUndefined();
    expect(rs.statusCode).toBe(402);
  });

  it('does not attempt settlement when verification fails', async () => {
    const mw = veridexPaywall({ amount: '1', recipient: RECIPIENT, verifyPayment: vi.fn().mockResolvedValue(false) });
    const next = vi.fn();
    await mw(req({ 'payment-signature': 'p' }), res(), next);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('createPaywallHandler — settlement is blocking and fail-closed', () => {
  it('returns true only after settlement succeeds', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, transaction: TX_HASH }));
    const handler = createPaywallHandler({ amount: '1', recipient: RECIPIENT, verifyPayment: verifyOk() });
    const rq = req({ 'x-ucp-payment-credential': '{}' });

    await expect(handler(rq, res())).resolves.toBe(true);
    expect(rq.veridexPayment.verified).toBe(true);
    expect(rq.veridexPayment.settlement.txHash).toBe(TX_HASH);
  });

  it.each(FAILING_SETTLEMENTS)('returns false on %s', async (_label, impl) => {
    mockFetch.mockImplementationOnce(impl);
    const handler = createPaywallHandler({ amount: '1', recipient: RECIPIENT, verifyPayment: verifyOk() });
    const rq = req({ 'x-acp-payment-token': 't' });
    const rs = res();

    await expect(handler(rq, rs)).resolves.toBe(false);
    expect(rq.veridexPayment).toBeUndefined();
    expect(rs.statusCode).toBe(402);
  });

  it('returns false when settlement times out', async () => {
    mockFetch.mockImplementationOnce(hangUntilAborted);
    const handler = createPaywallHandler({ amount: '1', recipient: RECIPIENT, verifyPayment: verifyOk(), settlementTimeoutMs: 20 });
    const rq = req({ 'x-ap2-fulfillment': '{}' });
    await expect(handler(rq, res())).resolves.toBe(false);
    expect(rq.veridexPayment).toBeUndefined();
  });
});

describe('facilitator verification stays fail-closed', () => {
  it('rejects (and never settles) when facilitator /verify is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    const mw = veridexPaywall({ amount: '1000000', rawAmount: true, recipient: RECIPIENT });
    const rq = req({ 'payment-signature': x402Payload() });
    const rs = res();
    const next = vi.fn();

    await mw(rq, rs, next);

    expect(next).not.toHaveBeenCalled();
    expect(rs.statusCode).toBe(402);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/verify$/);
  });

  it('rejects when facilitator /verify returns non-2xx', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 503));
    const handler = createPaywallHandler({ amount: '1000000', rawAmount: true, recipient: RECIPIENT });
    await expect(handler(req({ 'payment-signature': x402Payload() }), res())).resolves.toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('built-in verify + successful settle grants access (end to end)', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ isValid: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true, transaction: TX_HASH }));
    const mw = veridexPaywall({ amount: '1000000', rawAmount: true, recipient: RECIPIENT });
    const next = vi.fn();
    await mw(req({ 'payment-signature': x402Payload() }), res(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('built-in verify succeeds but settle fails → no access', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ isValid: true }))
      .mockResolvedValueOnce(jsonResponse({ success: false, errorReason: 'nonce_used' }));
    const mw = veridexPaywall({ amount: '1000000', rawAmount: true, recipient: RECIPIENT });
    const rq = req({ 'payment-signature': x402Payload() });
    const next = vi.fn();
    await mw(rq, res(), next);
    expect(next).not.toHaveBeenCalled();
    expect(rq.veridexPayment).toBeUndefined();
  });
});

describe('withPaywall (Next.js App Router) — settlement is blocking and fail-closed', () => {
  const config = { amount: '1', recipient: RECIPIENT, network: 'base-sepolia', facilitatorUrl: 'https://f.example', fallbackFacilitatorUrl: 'https://fb.example' };
  const request = () => new Request('https://api.example.com/x', { headers: { 'payment-signature': x402Payload() } });

  it('returns paid: true only after settlement succeeds', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      url.endsWith('/verify')
        ? jsonResponse({ isValid: true })
        : jsonResponse({ success: true, transaction: TX_HASH }));

    const result = await withPaywall(request(), config);
    expect(result.paid).toBe(true);
    expect(result.payment?.verified).toBe(true);
    expect(result.payment?.settlement?.txHash).toBe(TX_HASH);
  });

  it.each([
    ['all facilitators fail', async (url: string) => url.endsWith('/verify') ? jsonResponse({ isValid: true }) : jsonResponse({}, 500)],
    ['2xx explicit rejection', async (url: string) => url.endsWith('/verify') ? jsonResponse({ isValid: true }) : jsonResponse({ success: false, errorReason: 'x' })],
    ['2xx with no tx hash', async (url: string) => url.endsWith('/verify') ? jsonResponse({ isValid: true }) : jsonResponse({ success: true })],
  ])('returns paid: false when %s', async (_label, impl) => {
    mockFetch.mockImplementation(impl as any);
    const result = await withPaywall(request(), config);
    expect(result.paid).toBe(false);
    expect(result.payment).toBeUndefined();
    expect(result.response.status).toBe(402);
  });
});

describe('validateSettlementResponse contract', () => {
  it('accepts a complete EVM settlement', () => {
    expect(validateSettlementResponse({ success: true, transaction: TX_HASH }, 'eip155:8453').ok).toBe(true);
    expect(validateSettlementResponse({ success: true, txHash: TX_HASH, status: 'confirmed' }, 'base-mainnet').ok).toBe(true);
  });

  it('accepts a non-EVM tx reference of reasonable shape', () => {
    expect(validateSettlementResponse({ success: true, transaction: 'a'.repeat(64) }, 'stellar:pubnet').ok).toBe(true);
    expect(validateSettlementResponse({ success: true, transaction: 'short' }, 'stellar:pubnet').ok).toBe(false);
  });

  it.each([null, 'ok', [], { success: true }, { success: 1, transaction: TX_HASH }])('rejects %j', (body) => {
    expect(validateSettlementResponse(body, 'base-mainnet').ok).toBe(false);
  });
});
