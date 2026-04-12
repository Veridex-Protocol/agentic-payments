/**
 * Tests for the universal veridexPaywall middleware, createPaywallHandler,
 * and createProtocolRoutes — covering all four protocols (x402, UCP, ACP, AP2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  veridexPaywall,
  createPaywallHandler,
  createProtocolRoutes,
  PaywallConfig,
  ServerProtocol,
} from '../src/middleware/veridexPaywall';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const RECIPIENT = '0x1234567890abcdef1234567890abcdef12345678';

function createMockReq(headers: Record<string, string> = {}, extra: Record<string, any> = {}): any {
  return {
    headers: { host: 'api.example.com', ...headers },
    protocol: 'https',
    ...extra,
  };
}

function createMockRes(): any {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(key: string, value: string) {
      res.headers[key] = value;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// -----------------------------------------------------------------------
// 1. Simplified config defaults
// -----------------------------------------------------------------------

describe('Config defaults', () => {
  it('should only require amount and recipient', async () => {
    const middleware = veridexPaywall({ amount: '0.01', recipient: RECIPIENT });
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(res.body.network).toBe('base-mainnet');
    expect(res.body.token).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(res.body.recipient).toBe(RECIPIENT);
    expect(next).not.toHaveBeenCalled();
  });

  it('should convert human-readable amount to raw token units', async () => {
    const middleware = veridexPaywall({ amount: '0.50', recipient: RECIPIENT });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.body.amount).toBe('0.50');
    expect(res.body.amountRaw).toBe('500000');
  });

  it('should pass raw amounts through when rawAmount: true', async () => {
    const middleware = veridexPaywall({ amount: '1000000', recipient: RECIPIENT, rawAmount: true });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.body.amountRaw).toBe('1000000');
    expect(res.body.amount).toBe('1');
  });

  it('should resolve USDC address per network', async () => {
    const middleware = veridexPaywall({ amount: '1', recipient: RECIPIENT, network: 'ethereum-mainnet' });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.body.token).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  });

  it('should enable all four protocols by default', async () => {
    const middleware = veridexPaywall({ amount: '0.01', recipient: RECIPIENT });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.body.protocols).toEqual(['x402', 'ucp', 'acp', 'ap2']);
  });
});

// -----------------------------------------------------------------------
// 2. Multi-protocol header advertising
// -----------------------------------------------------------------------

describe('Protocol header advertising', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should set x402 PAYMENT-REQUIRED header (base64 JSON)', async () => {
    const middleware = veridexPaywall({ amount: '0.01', recipient: RECIPIENT });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.headers['PAYMENT-REQUIRED']).toBeDefined();
    const decoded = JSON.parse(Buffer.from(res.headers['PAYMENT-REQUIRED'], 'base64').toString('utf-8'));
    expect(decoded.paymentRequirements[0].payTo).toBe(RECIPIENT);
    expect(decoded.paymentRequirements[0].maxAmountRequired).toBe('10000');
  });

  it('should set UCP headers (x-ucp-initiation-url + Link)', async () => {
    const middleware = veridexPaywall({ amount: '0.01', recipient: RECIPIENT });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.headers['x-ucp-initiation-url']).toBe('https://api.example.com/.well-known/ucp');
    expect(res.headers['Link']).toContain('rel="ucp-manifest"');
  });

  it('should set ACP headers (openai-acp-version + x-acp-checkout-url)', async () => {
    const middleware = veridexPaywall({ amount: '0.01', recipient: RECIPIENT });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.headers['openai-acp-version']).toBe('2026-01');
    expect(res.headers['x-acp-checkout-url']).toBe('https://api.example.com/.well-known/acp-checkout');
  });

  it('should set AP2 header (x-ap2-mandate-url)', async () => {
    const middleware = veridexPaywall({ amount: '0.01', recipient: RECIPIENT });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.headers['x-ap2-mandate-url']).toBe('https://api.example.com/.well-known/ap2-mandate');
  });

  it('should only advertise enabled protocols', async () => {
    const middleware = veridexPaywall({
      amount: '0.01',
      recipient: RECIPIENT,
      protocols: ['x402'],
    });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.headers['PAYMENT-REQUIRED']).toBeDefined();
    expect(res.headers['x-ucp-initiation-url']).toBeUndefined();
    expect(res.headers['openai-acp-version']).toBeUndefined();
    expect(res.headers['x-ap2-mandate-url']).toBeUndefined();
    expect(res.body.protocols).toEqual(['x402']);
  });

  it('should include description in response body', async () => {
    const middleware = veridexPaywall({
      amount: '0.01',
      recipient: RECIPIENT,
      description: 'Premium API access',
    });
    const req = createMockReq();
    const res = createMockRes();

    await middleware(req, res, vi.fn());

    expect(res.body.description).toBe('Premium API access');
  });
});

// -----------------------------------------------------------------------
// 3. Incoming protocol detection — x402
// -----------------------------------------------------------------------

describe('x402 incoming detection and verification', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should detect x402 via payment-signature header', async () => {
    const customVerify = vi.fn().mockResolvedValue(true);
    const middleware = veridexPaywall({
      amount: '1',
      recipient: RECIPIENT,
      verifyPayment: customVerify,
    });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    const req = createMockReq({ 'payment-signature': 'x402-payload' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(customVerify).toHaveBeenCalledWith('x402-payload', 'x402', expect.anything());
    expect(next).toHaveBeenCalled();
    expect(req.veridexPayment.protocol).toBe('x402');
    expect(req.veridexPayment.verified).toBe(true);
  });

  it('should detect x402 via PAYMENT-SIGNATURE (uppercase)', async () => {
    const customVerify = vi.fn().mockResolvedValue(true);
    const middleware = veridexPaywall({
      amount: '1',
      recipient: RECIPIENT,
      verifyPayment: customVerify,
    });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const req = createMockReq({ 'PAYMENT-SIGNATURE': 'x402-upper' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(customVerify).toHaveBeenCalledWith('x402-upper', 'x402', expect.anything());
    expect(next).toHaveBeenCalled();
  });

  it('should reject invalid x402 base64 with built-in verifier', async () => {
    const middleware = veridexPaywall({ amount: '1', recipient: RECIPIENT, rawAmount: true });
    const req = createMockReq({ 'payment-signature': 'not-valid-base64!!!' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject x402 with wrong recipient', async () => {
    const payload = Buffer.from(JSON.stringify({
      x402Version: 1, scheme: 'exact', network: 'base-mainnet',
      payload: {
        signature: '0xabc',
        authorization: {
          from: '0xsender', to: '0xwrongrecipient000000000000000000000000',
          value: '1000000', validAfter: 0,
          validBefore: Math.floor(Date.now() / 1000) + 300, nonce: '0x1',
        },
      },
    })).toString('base64');

    const middleware = veridexPaywall({ amount: '1000000', recipient: RECIPIENT, rawAmount: true });
    const req = createMockReq({ 'payment-signature': payload });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject x402 with insufficient amount', async () => {
    const payload = Buffer.from(JSON.stringify({
      x402Version: 1, scheme: 'exact', network: 'base-mainnet',
      payload: {
        signature: '0xabc',
        authorization: {
          from: '0xsender', to: RECIPIENT,
          value: '500000', validAfter: 0,
          validBefore: Math.floor(Date.now() / 1000) + 300, nonce: '0x1',
        },
      },
    })).toString('base64');

    const middleware = veridexPaywall({ amount: '1000000', recipient: RECIPIENT, rawAmount: true });
    const req = createMockReq({ 'payment-signature': payload });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject expired x402 payment', async () => {
    const payload = Buffer.from(JSON.stringify({
      x402Version: 1, scheme: 'exact', network: 'base-mainnet',
      payload: {
        signature: '0xabc',
        authorization: {
          from: '0xsender', to: RECIPIENT,
          value: '1000000', validAfter: 0,
          validBefore: Math.floor(Date.now() / 1000) - 100, nonce: '0x1',
        },
      },
    })).toString('base64');

    const middleware = veridexPaywall({ amount: '1000000', recipient: RECIPIENT, rawAmount: true });
    const req = createMockReq({ 'payment-signature': payload });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// 4. Incoming protocol detection — UCP, ACP, AP2
// -----------------------------------------------------------------------

describe('UCP incoming detection', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should detect UCP via x-ucp-payment-credential header', async () => {
    const customVerify = vi.fn().mockResolvedValue(true);
    const middleware = veridexPaywall({
      amount: '0.01',
      recipient: RECIPIENT,
      verifyPayment: customVerify,
    });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const req = createMockReq({ 'x-ucp-payment-credential': '{"payload":"...","signature":"0x...","signer":"0x..."}' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(customVerify).toHaveBeenCalledWith(expect.any(String), 'ucp', expect.anything());
    expect(next).toHaveBeenCalled();
  });

  it('should reject UCP credential missing required fields', async () => {
    const middleware = veridexPaywall({ amount: '0.01', recipient: RECIPIENT });
    const req = createMockReq({ 'x-ucp-payment-credential': '{"incomplete": true}' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('ACP incoming detection', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should detect ACP via x-acp-payment-token header', async () => {
    const customVerify = vi.fn().mockResolvedValue(true);
    const middleware = veridexPaywall({
      amount: '0.01',
      recipient: RECIPIENT,
      verifyPayment: customVerify,
    });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const req = createMockReq({ 'x-acp-payment-token': 'base64url-acp-token' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(customVerify).toHaveBeenCalledWith('base64url-acp-token', 'acp', expect.anything());
    expect(next).toHaveBeenCalled();
  });
});

describe('AP2 incoming detection', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should detect AP2 via x-ap2-fulfillment header', async () => {
    const customVerify = vi.fn().mockResolvedValue(true);
    const middleware = veridexPaywall({
      amount: '0.01',
      recipient: RECIPIENT,
      verifyPayment: customVerify,
    });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const req = createMockReq({ 'x-ap2-fulfillment': '{"mandate_id":"m-1","signature":"0x..."}' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(customVerify).toHaveBeenCalledWith(expect.any(String), 'ap2', expect.anything());
    expect(next).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// 5. Protocol filtering
// -----------------------------------------------------------------------

describe('Protocol filtering', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should reject payment from disabled protocol', async () => {
    const middleware = veridexPaywall({
      amount: '0.01',
      recipient: RECIPIENT,
      protocols: ['x402'],
    });

    const req = createMockReq({ 'x-ucp-payment-credential': '{"payload":"x","signature":"x","signer":"x"}' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(res.body.error).toContain('not enabled');
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept payment from enabled protocol', async () => {
    const customVerify = vi.fn().mockResolvedValue(true);
    const middleware = veridexPaywall({
      amount: '0.01',
      recipient: RECIPIENT,
      protocols: ['ucp'],
      verifyPayment: customVerify,
    });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const req = createMockReq({ 'x-ucp-payment-credential': 'cred-data' });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// 6. createPaywallHandler (Next.js / generic)
// -----------------------------------------------------------------------

describe('createPaywallHandler', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('should return false and send 402 when no payment', async () => {
    const handler = createPaywallHandler({ amount: '0.01', recipient: RECIPIENT });
    const req = createMockReq();
    const res = createMockRes();

    const result = await handler(req, res);

    expect(result).toBe(false);
    expect(res.statusCode).toBe(402);
    expect(res.body.protocols).toEqual(['x402', 'ucp', 'acp', 'ap2']);
  });

  it('should return true when payment is valid', async () => {
    const handler = createPaywallHandler({
      amount: '0.01',
      recipient: RECIPIENT,
      verifyPayment: vi.fn().mockResolvedValue(true),
    });

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const req = createMockReq({ 'payment-signature': 'valid-sig' });
    const res = createMockRes();

    const result = await handler(req, res);
    expect(result).toBe(true);
  });

  it('should return false when verification fails', async () => {
    const handler = createPaywallHandler({
      amount: '0.01',
      recipient: RECIPIENT,
      verifyPayment: vi.fn().mockResolvedValue(false),
    });

    const req = createMockReq({ 'payment-signature': 'bad-sig' });
    const res = createMockRes();

    const result = await handler(req, res);
    expect(result).toBe(false);
    expect(res.statusCode).toBe(402);
  });

  it('should return false when verifier throws', async () => {
    const handler = createPaywallHandler({
      amount: '0.01',
      recipient: RECIPIENT,
      verifyPayment: vi.fn().mockRejectedValue(new Error('down')),
    });

    const req = createMockReq({ 'payment-signature': 'some-sig' });
    const res = createMockRes();

    const result = await handler(req, res);
    expect(result).toBe(false);
    expect(res.statusCode).toBe(402);
  });

  it('should reject disabled protocol in handler mode', async () => {
    const handler = createPaywallHandler({
      amount: '0.01',
      recipient: RECIPIENT,
      protocols: ['acp'],
    });

    const req = createMockReq({ 'payment-signature': 'x402-sig' });
    const res = createMockRes();

    const result = await handler(req, res);
    expect(result).toBe(false);
    expect(res.body.error).toContain('not enabled');
  });
});

// -----------------------------------------------------------------------
// 7. createProtocolRoutes (.well-known endpoints)
// -----------------------------------------------------------------------

describe('createProtocolRoutes', () => {
  const config: PaywallConfig = {
    amount: '0.50',
    recipient: RECIPIENT,
    merchantName: 'Test Merchant',
    description: 'API access',
  };

  it('should serve UCP manifest at /.well-known/ucp', () => {
    const routes = createProtocolRoutes(config);
    const req = createMockReq({}, { path: '/.well-known/ucp' });
    const res = createMockRes();
    const next = vi.fn();

    routes(req, res, next);

    expect(res.body).toBeDefined();
    expect(res.body.name).toBe('Test Merchant');
    expect(res.body.paymentHandlers).toHaveLength(1);
    expect(res.body.paymentHandlers[0].name).toBe('dev.veridex.passkey_payment');
    expect(res.body.paymentHandlers[0].config.recipient_address).toBe(RECIPIENT);
    expect(next).not.toHaveBeenCalled();
  });

  it('should serve ACP checkout at /.well-known/acp-checkout', () => {
    const routes = createProtocolRoutes(config);
    const req = createMockReq({}, { path: '/.well-known/acp-checkout' });
    const res = createMockRes();
    const next = vi.fn();

    routes(req, res, next);

    expect(res.body).toBeDefined();
    expect(res.body.total).toBe(0.5);
    expect(res.body.currency).toBe('USD');
    expect(res.body.merchant.name).toBe('Test Merchant');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('API access');
    expect(next).not.toHaveBeenCalled();
  });

  it('should serve AP2 mandate at /.well-known/ap2-mandate', () => {
    const routes = createProtocolRoutes(config);
    const req = createMockReq({}, { path: '/.well-known/ap2-mandate' });
    const res = createMockRes();
    const next = vi.fn();

    routes(req, res, next);

    expect(res.body).toBeDefined();
    expect(res.body.version).toBe('2026-01');
    expect(res.body.cart_mandate.max_value.amount).toBe(0.5);
    expect(res.body.cart_mandate.max_value.currency).toBe('USD');
    expect(res.body.payment_mandate.provider).toBe('veridex');
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next() for unmatched paths', () => {
    const routes = createProtocolRoutes(config);
    const req = createMockReq({}, { path: '/api/data' });
    const res = createMockRes();
    const next = vi.fn();

    routes(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.body).toBeNull();
  });

  it('should skip disabled protocol endpoints', () => {
    const routes = createProtocolRoutes({ ...config, protocols: ['x402'] });
    const req = createMockReq({}, { path: '/.well-known/ucp' });
    const res = createMockRes();
    const next = vi.fn();

    routes(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.body).toBeNull();
  });

  it('should use custom cart items for ACP', () => {
    const routes = createProtocolRoutes({
      ...config,
      cartItems: [
        { name: 'Premium Plan', quantity: 1, unitPrice: 9.99 },
        { name: 'Add-on', quantity: 2, unitPrice: 1.50 },
      ],
    });
    const req = createMockReq({}, { path: '/.well-known/acp-checkout' });
    const res = createMockRes();

    routes(req, res, vi.fn());

    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].name).toBe('Premium Plan');
    expect(res.body.items[1].name).toBe('Add-on');
    expect(res.body.total).toBeCloseTo(12.99);
  });

  it('should use custom mandate TTL for AP2', () => {
    const routes = createProtocolRoutes({ ...config, mandateTTLSeconds: 600 });
    const req = createMockReq({}, { path: '/.well-known/ap2-mandate' });
    const res = createMockRes();

    routes(req, res, vi.fn());

    const expiresAt = new Date(res.body.cart_mandate.expires_at).getTime();
    const now = Date.now();
    // Should expire ~600s from now (allow 5s tolerance)
    expect(expiresAt - now).toBeGreaterThan(595_000);
    expect(expiresAt - now).toBeLessThan(605_000);
  });

  it('should use custom allowed categories for AP2', () => {
    const routes = createProtocolRoutes({ ...config, allowedCategories: ['data', 'compute'] });
    const req = createMockReq({}, { path: '/.well-known/ap2-mandate' });
    const res = createMockRes();

    routes(req, res, vi.fn());

    expect(res.body.cart_mandate.allowed_categories).toEqual(['data', 'compute']);
  });
});
