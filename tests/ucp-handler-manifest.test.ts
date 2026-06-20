/**
 * UCPHandler manifest-discovery tests.
 *
 * Exercises the `.well-known/ucp` / `Link: rel="ucp-manifest"` discovery flow:
 * the handler must fetch and validate an untrusted merchant manifest, confirm
 * it advertises the `checkout` capability and the Veridex payment handler,
 * derive the checkout endpoint from the manifest, and reject malformed or
 * cross-origin manifests before any money moves.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { UCPHandler } from '../src/protocols/ucp/UCPHandler';
import { AgentPaymentError, AgentPaymentErrorCode } from '../src/types/errors';
import type { ProtocolContext } from '../src/protocols/base/types';
import type { StoredSession } from '../src/session/SessionStorage';

const VERIDEX_HANDLER_NAME = 'dev.veridex.passkey_payment';
const RESOURCE_URL = 'https://merchant.example/premium/resource';
const ORIGIN = 'https://merchant.example';

function createSession(): StoredSession {
  return {
    keyHash: `0x${'a'.repeat(64)}`,
    encryptedPrivateKey: `0x${'b'.repeat(64)}`,
    publicKey: `0x04${'c'.repeat(128)}`,
    config: {
      dailyLimitUSD: 100,
      perTransactionLimitUSD: 25,
      expiryTimestamp: Date.now() + 3_600_000,
      allowedChains: [30],
    },
    metadata: {
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      totalSpentUSD: 0,
      dailySpentUSD: 0,
      dailyResetAt: Date.now() + 86_400_000,
      transactionCount: 0,
    },
    masterKeyHash: `0x${'d'.repeat(64)}`,
  } as StoredSession;
}

function createContext(): ProtocolContext {
  return {
    session: createSession(),
    signerWallet: ethers.Wallet.createRandom(),
  } as ProtocolContext;
}

/** A well-formed manifest advertising checkout + the Veridex handler. */
function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.0',
    name: 'Example Merchant',
    capabilities: ['checkout', 'orders'],
    paymentHandlers: [
      {
        id: 'veridex-1',
        name: VERIDEX_HANDLER_NAME,
        config: {
          recipient_address: `0x${'e'.repeat(40)}`,
          chain_id: 30,
          token_address: `0x${'f'.repeat(40)}`,
          amount: '5.00',
        },
      },
    ],
    checkoutUrl: '/ucp/checkout',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Build a fetch mock that serves a manifest, a checkout creation, completion,
 * and the final retried request. Records every call for assertions.
 */
function installFetchMock(manifestBody: unknown, opts: { manifestStatus?: number } = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });

    if (url.endsWith('/.well-known/ucp') && method === 'GET') {
      if (opts.manifestStatus && opts.manifestStatus >= 400) {
        return new Response('not found', { status: opts.manifestStatus });
      }
      return jsonResponse(manifestBody);
    }
    if (url === `${ORIGIN}/ucp/checkout` && method === 'POST') {
      return jsonResponse({
        checkout_id: 'co_123',
        handlers: [
          {
            id: 'veridex-1',
            name: VERIDEX_HANDLER_NAME,
            config: {
              recipient_address: `0x${'e'.repeat(40)}`,
              chain_id: 30,
              token_address: `0x${'f'.repeat(40)}`,
              amount: '5.00',
            },
          },
        ],
        total: { amount: '5.00', currency: 'USD' },
        status: 'pending',
      });
    }
    if (url.includes('/complete') && method === 'POST') {
      return new Response('', { status: 200 });
    }
    // Final retried request.
    return new Response('granted', { status: 200 });
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

async function expectNegotiationError(promise: Promise<unknown>): Promise<AgentPaymentError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AgentPaymentError);
    expect((err as AgentPaymentError).code).toBe(AgentPaymentErrorCode.UCP_NEGOTIATION_FAILED);
    return err as AgentPaymentError;
  }
  throw new Error('expected the handler to throw a UCP negotiation error');
}

describe('UCPHandler manifest discovery', () => {
  let handler: UCPHandler;

  beforeEach(() => {
    handler = new UCPHandler();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('discovers the manifest and creates a checkout at the manifest-declared endpoint', async () => {
    const { calls } = installFetchMock(validManifest());
    const res = await handler.handle(RESOURCE_URL, {}, createContext(), new Response(null));

    expect(res.status).toBe(200);
    // Manifest was fetched from the well-known location...
    expect(calls.some((c) => c.url === `${ORIGIN}/.well-known/ucp` && c.method === 'GET')).toBe(true);
    // ...and the checkout was POSTed to the manifest-declared endpoint, not the manifest URL.
    expect(calls.some((c) => c.url === `${ORIGIN}/ucp/checkout` && c.method === 'POST')).toBe(true);
  });

  it('rejects a manifest that does not advertise the checkout capability', async () => {
    installFetchMock(validManifest({ capabilities: ['orders'] }));
    const err = await expectNegotiationError(
      handler.handle(RESOURCE_URL, {}, createContext(), new Response(null))
    );
    expect(err.message).toContain('checkout');
  });

  it('rejects a manifest that does not advertise the Veridex handler', async () => {
    installFetchMock(
      validManifest({ paymentHandlers: [{ id: 'x', name: 'com.other.pay', config: {} }] })
    );
    const err = await expectNegotiationError(
      handler.handle(RESOURCE_URL, {}, createContext(), new Response(null))
    );
    expect(err.message).toContain('does not advertise Veridex');
  });

  it('rejects a manifest missing a version', async () => {
    installFetchMock(validManifest({ version: undefined }));
    const err = await expectNegotiationError(
      handler.handle(RESOURCE_URL, {}, createContext(), new Response(null))
    );
    expect(err.message).toContain('version');
  });

  it('rejects a manifest body that is not valid JSON', async () => {
    installFetchMock('{ not json');
    await expectNegotiationError(
      handler.handle(RESOURCE_URL, {}, createContext(), new Response(null))
    );
  });

  it('rejects a manifest fetch that returns an error status', async () => {
    installFetchMock(validManifest(), { manifestStatus: 404 });
    await expectNegotiationError(
      handler.handle(RESOURCE_URL, {}, createContext(), new Response(null))
    );
  });

  it('rejects a cross-origin manifest Link header (SSRF guard)', async () => {
    installFetchMock(validManifest());
    const originalResponse = new Response(null, {
      headers: { link: '<http://169.254.169.254/latest/meta-data>; rel="ucp-manifest"' },
    });
    const err = await expectNegotiationError(
      handler.handle(RESOURCE_URL, {}, createContext(), originalResponse)
    );
    expect(err.message).toContain('different origin');
  });

  it('tolerates snake_case payment_handlers and absolute checkoutUrl', async () => {
    const { calls } = installFetchMock({
      version: '1.0',
      capabilities: ['checkout'],
      payment_handlers: [
        {
          name: VERIDEX_HANDLER_NAME,
          config: { recipient_address: `0x${'e'.repeat(40)}`, chain_id: 30, amount: '5.00' },
        },
      ],
      checkout_url: `${ORIGIN}/ucp/checkout`,
    });
    const res = await handler.handle(RESOURCE_URL, {}, createContext(), new Response(null));
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url === `${ORIGIN}/ucp/checkout` && c.method === 'POST')).toBe(true);
  });
});
