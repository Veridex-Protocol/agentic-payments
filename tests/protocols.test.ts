/**
 * Tests for the Universal Protocol Abstraction Layer (ADR-0025)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProtocolDetector } from '../src/protocols/base/ProtocolDetector';
import { ProtocolHandler } from '../src/protocols/base/ProtocolHandler';
import { X402Handler } from '../src/protocols/x402/X402Handler';
import { UCPHandler } from '../src/protocols/ucp/UCPHandler';
import { ACPHandler } from '../src/protocols/acp/ACPHandler';
import { AP2Handler, MandateMapper } from '../src/protocols/ap2/AP2Handler';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockResponse(status: number, headers: Record<string, string> = {}, body?: any): Response {
  const headersObj = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headersObj,
    json: async () => body || {},
    text: async () => JSON.stringify(body || {}),
    clone: () => createMockResponse(status, headers, body),
  } as unknown as Response;
}

describe('ProtocolDetector', () => {
  let detector: ProtocolDetector;

  beforeEach(() => {
    detector = new ProtocolDetector();
    detector.registerHandlers([
      new UCPHandler(),
      new ACPHandler(),
      new AP2Handler(),
      new X402Handler(),
    ]);
  });

  it('should register handlers sorted by priority', () => {
    const handlers = detector.getHandlers();
    expect(handlers.length).toBe(4);
    expect(handlers[0].protocolName).toBe('ucp');   // 100
    expect(handlers[1].protocolName).toBe('acp');    // 90
    expect(handlers[2].protocolName).toBe('ap2');    // 80
    expect(handlers[3].protocolName).toBe('x402');   // 70
  });

  it('should detect x402 from 402 + PAYMENT-REQUIRED header', async () => {
    const paymentRequired = Buffer.from(JSON.stringify({
      paymentRequirements: [{
        scheme: 'exact',
        network: 'base-mainnet',
        maxAmountRequired: '1000000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
      }],
    })).toString('base64');

    const response = createMockResponse(402, { 'payment-required': paymentRequired });
    const handler = await detector.detect(response, 'https://example.com/api');

    expect(handler).not.toBeNull();
    expect(handler!.protocolName).toBe('x402');
  });

  it('should detect ACP from openai-acp-version header', async () => {
    const response = createMockResponse(200, { 'openai-acp-version': '2026-01' });
    const handler = await detector.detect(response, 'https://example.com/api');

    expect(handler).not.toBeNull();
    expect(handler!.protocolName).toBe('acp');
  });

  it('should detect AP2 from x-ap2-mandate-url header', async () => {
    const response = createMockResponse(200, {
      'x-ap2-mandate-url': 'https://example.com/mandate/123',
    });
    const handler = await detector.detect(response, 'https://example.com/api');

    expect(handler).not.toBeNull();
    expect(handler!.protocolName).toBe('ap2');
  });

  it('should detect UCP from Link header with ucp-manifest', async () => {
    const response = createMockResponse(200, {
      'link': '<https://example.com/.well-known/ucp>; rel="ucp-manifest"',
    });
    const handler = await detector.detect(response, 'https://example.com/api');

    expect(handler).not.toBeNull();
    expect(handler!.protocolName).toBe('ucp');
  });

  it('should detect UCP from x-ucp-initiation-url header', async () => {
    const response = createMockResponse(402, {
      'x-ucp-initiation-url': 'https://example.com/checkout',
    });
    const handler = await detector.detect(response, 'https://example.com/api');

    expect(handler).not.toBeNull();
    expect(handler!.protocolName).toBe('ucp');
  });

  it('should return null when no protocol is detected', async () => {
    const response = createMockResponse(200);
    const handler = await detector.detect(response, 'https://example.com/api');

    expect(handler).toBeNull();
  });

  it('should respect allowedProtocols filter', async () => {
    const paymentRequired = Buffer.from(JSON.stringify({
      paymentRequirements: [{
        scheme: 'exact',
        network: 'base-mainnet',
        maxAmountRequired: '1000000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
      }],
    })).toString('base64');

    const response = createMockResponse(402, { 'payment-required': paymentRequired });

    // Only allow UCP — x402 should not match
    const handler = await detector.detect(response, 'https://example.com/api', ['ucp']);
    expect(handler).toBeNull();
  });

  it('should force-select handler by protocol name', () => {
    const handler = detector.getHandler('x402');
    expect(handler).not.toBeNull();
    expect(handler!.protocolName).toBe('x402');
  });

  it('should cache detection results per origin', async () => {
    const paymentRequired = Buffer.from(JSON.stringify({
      paymentRequirements: [{
        scheme: 'exact',
        network: 'base-mainnet',
        maxAmountRequired: '1000000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
      }],
    })).toString('base64');

    const response = createMockResponse(402, { 'payment-required': paymentRequired });

    // First detection
    const handler1 = await detector.detect(response, 'https://example.com/api');
    expect(handler1!.protocolName).toBe('x402');

    // Second detection should use cache (even with different response)
    const response2 = createMockResponse(200);
    const handler2 = await detector.detect(response2, 'https://example.com/other');
    expect(handler2!.protocolName).toBe('x402');
  });

  it('should clear cache', async () => {
    const paymentRequired = Buffer.from(JSON.stringify({
      paymentRequirements: [{
        scheme: 'exact',
        network: 'base-mainnet',
        maxAmountRequired: '1000000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
      }],
    })).toString('base64');

    const response = createMockResponse(402, { 'payment-required': paymentRequired });
    await detector.detect(response, 'https://example.com/api');

    detector.clearCache();

    // After clearing, a non-402 response should not match
    const response2 = createMockResponse(200);
    const handler = await detector.detect(response2, 'https://example.com/api');
    expect(handler).toBeNull();
  });

  it('should return structured detection result with metadata', async () => {
    const response = createMockResponse(200, { 'openai-acp-version': '2026-01' });
    const result = await detector.detectWithMetadata(response, 'https://example.com/api');

    expect(result).not.toBeNull();
    expect(result!.protocol).toBe('acp');
    expect(result!.confidence).toBe(1.0);
    expect(result!.metadata).toHaveProperty('url');
    expect(result!.metadata).toHaveProperty('status');
  });
});

describe('X402Handler', () => {
  const handler = new X402Handler();

  it('should have correct protocol name and priority', () => {
    expect(handler.protocolName).toBe('x402');
    expect(handler.priority).toBe(70);
  });

  it('should detect 402 with payment-required header', async () => {
    const paymentRequired = Buffer.from(JSON.stringify({
      paymentRequirements: [{
        scheme: 'exact',
        network: 'base-mainnet',
        maxAmountRequired: '1000000',
        asset: 'USDC',
        payTo: '0x1234',
      }],
    })).toString('base64');

    const response = createMockResponse(402, { 'payment-required': paymentRequired });
    expect(await handler.canHandle(response, 'https://example.com')).toBe(true);
  });

  it('should not detect non-402 responses', async () => {
    const response = createMockResponse(200);
    expect(await handler.canHandle(response, 'https://example.com')).toBe(false);
  });

  it('should not detect 402 without payment-required header', async () => {
    const response = createMockResponse(402);
    expect(await handler.canHandle(response, 'https://example.com')).toBe(false);
  });

  it('should estimate cost from payment-required header', async () => {
    const paymentRequired = Buffer.from(JSON.stringify({
      paymentRequirements: [{
        scheme: 'exact',
        network: 'base-mainnet',
        maxAmountRequired: '1000000',
        asset: 'USDC',
        payTo: '0x1234',
      }],
    })).toString('base64');

    const response = createMockResponse(402, { 'payment-required': paymentRequired });
    const estimate = await handler.estimateCost(response);

    expect(estimate.amountUSD).toBe(1000000); // Raw amount (rough estimate without oracle)
    expect(estimate.scheme).toBe('exact');
    expect(estimate.confidence).toBeGreaterThan(0);
  });
});

describe('ACPHandler', () => {
  const handler = new ACPHandler();

  it('should have correct protocol name and priority', () => {
    expect(handler.protocolName).toBe('acp');
    expect(handler.priority).toBe(90);
  });

  it('should detect openai-acp-version header', async () => {
    const response = createMockResponse(200, { 'openai-acp-version': '2026-01' });
    expect(await handler.canHandle(response, 'https://example.com')).toBe(true);
  });

  it('should detect x-acp-checkout-url header', async () => {
    const response = createMockResponse(200, {
      'x-acp-checkout-url': 'https://example.com/checkout',
    });
    expect(await handler.canHandle(response, 'https://example.com')).toBe(true);
  });

  it('should not detect responses without ACP headers', async () => {
    const response = createMockResponse(200);
    expect(await handler.canHandle(response, 'https://example.com')).toBe(false);
  });
});

describe('AP2Handler', () => {
  const handler = new AP2Handler();

  it('should have correct protocol name and priority', () => {
    expect(handler.protocolName).toBe('ap2');
    expect(handler.priority).toBe(80);
  });

  it('should detect x-ap2-mandate-url header', async () => {
    const response = createMockResponse(200, {
      'x-ap2-mandate-url': 'https://example.com/mandate/123',
    });
    expect(await handler.canHandle(response, 'https://example.com')).toBe(true);
  });

  it('should detect x-google-a2a-mandate header', async () => {
    const response = createMockResponse(200, {
      'x-google-a2a-mandate': 'https://example.com/mandate/456',
    });
    expect(await handler.canHandle(response, 'https://example.com')).toBe(true);
  });

  it('should not detect responses without AP2 headers', async () => {
    const response = createMockResponse(200);
    expect(await handler.canHandle(response, 'https://example.com')).toBe(false);
  });
});

describe('UCPHandler', () => {
  const handler = new UCPHandler();

  it('should have correct protocol name and priority', () => {
    expect(handler.protocolName).toBe('ucp');
    expect(handler.priority).toBe(100);
  });

  it('should detect x-ucp-initiation-url header', async () => {
    const response = createMockResponse(200, {
      'x-ucp-initiation-url': 'https://example.com/checkout',
    });
    expect(await handler.canHandle(response, 'https://example.com')).toBe(true);
  });

  it('should detect Link header with ucp-manifest', async () => {
    const response = createMockResponse(200, {
      'link': '<https://example.com/.well-known/ucp>; rel="ucp-manifest"',
    });
    expect(await handler.canHandle(response, 'https://example.com')).toBe(true);
  });

  it('should not detect responses without UCP indicators', async () => {
    // Mock fetch for .well-known/ucp check
    mockFetch.mockResolvedValueOnce(createMockResponse(404));

    const response = createMockResponse(200);
    expect(await handler.canHandle(response, 'https://example.com')).toBe(false);
  });
});

describe('MandateMapper', () => {
  it('should convert session to AP2 mandate format', () => {
    const session = {
      keyHash: '0xabc123',
      publicKey: '0xdef456',
      config: {
        dailyLimitUSD: 100,
        expiryTimestamp: Date.now() + 86400000,
        allowedCategories: ['api', 'data'],
      },
      createdAt: Date.now(),
    };

    const mandate = MandateMapper.sessionToMandate(session);

    expect(mandate.version).toBe('2026-01');
    expect(mandate.cart_mandate.max_value.amount).toBe(100);
    expect(mandate.cart_mandate.max_value.currency).toBe('USD');
    expect(mandate.cart_mandate.allowed_categories).toEqual(['api', 'data']);
    expect(mandate.payment_mandate.provider).toBe('veridex');
    expect(mandate.payment_mandate.credential_type).toBe('session_key');
    expect(mandate.payment_mandate.credential?.key_hash).toBe('0xabc123');
    expect(mandate.intent_mandate.source).toBe('user_authorization');
  });

  it('should default to wildcard categories when not specified', () => {
    const session = {
      keyHash: '0xabc123',
      publicKey: '0xdef456',
      config: {
        dailyLimitUSD: 50,
        expiryTimestamp: Date.now() + 86400000,
      },
      createdAt: Date.now(),
    };

    const mandate = MandateMapper.sessionToMandate(session);
    expect(mandate.cart_mandate.allowed_categories).toEqual(['*']);
  });
});

describe('Protocol Priority Order', () => {
  it('should check UCP before x402 when both headers present', async () => {
    const detector = new ProtocolDetector();
    detector.registerHandlers([
      new UCPHandler(),
      new ACPHandler(),
      new AP2Handler(),
      new X402Handler(),
    ]);

    // Response has both UCP and x402 indicators
    const paymentRequired = Buffer.from(JSON.stringify({
      paymentRequirements: [{
        scheme: 'exact',
        network: 'base-mainnet',
        maxAmountRequired: '1000000',
        asset: 'USDC',
        payTo: '0x1234',
      }],
    })).toString('base64');

    const response = createMockResponse(402, {
      'payment-required': paymentRequired,
      'x-ucp-initiation-url': 'https://example.com/checkout',
    });

    const handler = await detector.detect(response, 'https://example.com/api');
    expect(handler!.protocolName).toBe('ucp'); // UCP has higher priority (100 > 70)
  });

  it('should check ACP before x402 when both headers present', async () => {
    const detector = new ProtocolDetector();
    detector.registerHandlers([
      new ACPHandler(),
      new X402Handler(),
    ]);

    const paymentRequired = Buffer.from(JSON.stringify({
      paymentRequirements: [{
        scheme: 'exact',
        network: 'base-mainnet',
        maxAmountRequired: '1000000',
        asset: 'USDC',
        payTo: '0x1234',
      }],
    })).toString('base64');

    const response = createMockResponse(402, {
      'payment-required': paymentRequired,
      'openai-acp-version': '2026-01',
    });

    const handler = await detector.detect(response, 'https://example.com/api');
    expect(handler!.protocolName).toBe('acp'); // ACP has higher priority (90 > 70)
  });
});
