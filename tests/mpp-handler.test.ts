/**
 * Tests for MPP Protocol Handler (Tempo Micropayments)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MPPHandler } from '../src/protocols/mpp/MPPHandler';
import type { ProtocolContext } from '../src/protocols/base/types';
import type { StoredSession } from '../src/session/SessionStorage';
import { ethers } from 'ethers';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockSession(): StoredSession {
  return {
    keyHash: '0xtest',
    encryptedPrivateKey: 'encrypted',
    passkeyCredentialId: 'cred-1',
    config: {
      dailyLimitUSD: 100,
      perTransactionLimitUSD: 50,
      expiryTimestamp: Date.now() + 86_400_000,
      allowedChains: [2, 30],
    },
    metadata: {
      createdAt: Date.now(),
      lastUsed: Date.now(),
      dailySpentUSD: 0,
      transactionCount: 0,
    },
  };
}

function createMockContext(overrides?: Partial<ProtocolContext>): ProtocolContext {
  return {
    session: createMockSession(),
    signerWallet: ethers.Wallet.createRandom(),
    ...overrides,
  };
}

function createMPPResponse(
  amount = '1000',
  currency = 'USDC',
  intentType = 'charge',
  method = 'tempo',
): Response {
  const headers = new Headers({
    'www-authenticate': `Payment method="${method}", intent="${intentType}", amount="${amount}", currency="${currency}", recipient="0xMerchant", request_id="req-123"`,
  });
  return {
    status: 402,
    ok: false,
    headers,
    json: async () => ({}),
    text: async () => '',
    clone: () => createMPPResponse(amount, currency, intentType, method),
  } as unknown as Response;
}

describe('MPPHandler', () => {
  let handler: MPPHandler;

  beforeEach(() => {
    handler = new MPPHandler();
    mockFetch.mockReset();
  });

  describe('canHandle', () => {
    it('should detect MPP from 402 + WWW-Authenticate: Payment header', async () => {
      const response = createMPPResponse();
      const result = await handler.canHandle(response, 'https://api.example.com');
      expect(result).toBe(true);
    });

    it('should reject non-402 responses', async () => {
      const response = {
        status: 200,
        headers: new Headers({ 'www-authenticate': 'Payment method="tempo"' }),
      } as unknown as Response;
      const result = await handler.canHandle(response, 'https://example.com');
      expect(result).toBe(false);
    });

    it('should reject 402 without WWW-Authenticate', async () => {
      const response = {
        status: 402,
        headers: new Headers(),
      } as unknown as Response;
      const result = await handler.canHandle(response, 'https://example.com');
      expect(result).toBe(false);
    });

    it('should reject non-Payment auth scheme', async () => {
      const response = {
        status: 402,
        headers: new Headers({ 'www-authenticate': 'Bearer realm="api"' }),
      } as unknown as Response;
      const result = await handler.canHandle(response, 'https://example.com');
      expect(result).toBe(false);
    });
  });

  describe('estimateCost', () => {
    it('should estimate cost from charge intent', async () => {
      const response = createMPPResponse('5000000', 'USDC');
      const estimate = await handler.estimateCost(response);

      expect(estimate.amountRaw).toBe('5000000');
      expect(estimate.token).toBe('USDC');
      expect(estimate.amountUSD).toBe(5); // 5M / 1M for stablecoin
      expect(estimate.scheme).toBe('exact');
      expect(estimate.confidence).toBe(0.95);
      expect(estimate.description).toContain('MPP charge');
    });

    it('should estimate streaming scheme for session intent', async () => {
      const response = createMPPResponse('100', 'USDC', 'session');
      const estimate = await handler.estimateCost(response);
      expect(estimate.scheme).toBe('streaming');
    });

    it('should return zero estimate for missing challenge', async () => {
      const response = {
        status: 402,
        headers: new Headers(),
      } as unknown as Response;
      const estimate = await handler.estimateCost(response);
      expect(estimate.amountUSD).toBe(0);
      expect(estimate.confidence).toBe(0);
    });
  });

  describe('handle', () => {
    it('should execute full Challenge-Credential-Receipt flow', async () => {
      const originalResponse = createMPPResponse('10', 'USDC');
      const context = createMockContext();

      // Mock the retry response
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({
          'payment-receipt': 'status="paid", tx_ref="tx-123"',
        }),
        json: async () => ({ data: 'paid content' }),
      });

      const response = await handler.handle(
        'https://api.example.com/resource',
        {},
        context,
        originalResponse,
      );

      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledOnce();

      // Verify Authorization header was set
      const [, fetchOpts] = mockFetch.mock.calls[0];
      const authHeader = fetchOpts.headers.get('authorization');
      expect(authHeader).toContain('Payment');
      expect(authHeader).toContain('method="tempo"');
    });

    it('should throw when original response is missing', async () => {
      const context = createMockContext();
      await expect(
        handler.handle('https://example.com', {}, context),
      ).rejects.toThrow('MPP handler requires the original 402 response');
    });

    it('should throw when payment exceeds per-transaction limit', async () => {
      const originalResponse = createMPPResponse('100000000', 'USDC'); // $100
      const context = createMockContext();
      context.session.config.perTransactionLimitUSD = 10;

      await expect(
        handler.handle('https://example.com', {}, context, originalResponse),
      ).rejects.toThrow('exceeds per-transaction limit');
    });

    it('should throw when payment exceeds daily limit', async () => {
      const originalResponse = createMPPResponse('50000000', 'USDC'); // $50
      const context = createMockContext();
      context.session.config.dailyLimitUSD = 100;
      context.session.metadata.dailySpentUSD = 80; // Only $20 remaining

      await expect(
        handler.handle('https://example.com', {}, context, originalResponse),
      ).rejects.toThrow('exceeds remaining daily limit');
    });

    it('should throw when server rejects payment', async () => {
      const originalResponse = createMPPResponse('10', 'USDC');
      const context = createMockContext();

      mockFetch.mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: new Headers(),
      });

      await expect(
        handler.handle('https://example.com', {}, context, originalResponse),
      ).rejects.toThrow('MPP payment was rejected');
    });

    it('should throw when no signer wallet available', async () => {
      const originalResponse = createMPPResponse('10', 'USDC');
      const context = createMockContext({ signerWallet: undefined });

      await expect(
        handler.handle('https://example.com', {}, context, originalResponse),
      ).rejects.toThrow('requires a signer wallet');
    });
  });

  describe('extractReceipt', () => {
    it('should extract receipt from response headers', () => {
      const response = {
        headers: new Headers({
          'payment-receipt': 'status="paid", tx_ref="tx-abc", amount="1000"',
        }),
      } as unknown as Response;

      const receipt = handler.extractReceipt(response);
      expect(receipt).not.toBeNull();
      expect(receipt!.status).toBe('paid');
      expect(receipt!.txRef).toBe('tx-abc');
      expect(receipt!.amount).toBe('1000');
    });

    it('should return null when no receipt header', () => {
      const response = {
        headers: new Headers(),
      } as unknown as Response;

      const receipt = handler.extractReceipt(response);
      expect(receipt).toBeNull();
    });
  });

  describe('settle', () => {
    it('should create settlement from payment data', async () => {
      const context = createMockContext();
      const settlement = await handler.settle(
        { txHash: '0xtx123', network: 'tempo-mainnet', amount: '1000', token: 'USDC' },
        context,
      );

      expect(settlement.success).toBe(true);
      expect(settlement.protocol).toBe('mpp');
      expect(settlement.txHash).toBe('0xtx123');
      expect(settlement.network).toBe('tempo-mainnet');
    });
  });

  describe('protocol metadata', () => {
    it('should have correct protocol name', () => {
      expect(handler.protocolName).toBe('mpp');
    });

    it('should have priority 85', () => {
      expect(handler.priority).toBe(85);
    });
  });

  describe('custom config', () => {
    it('should accept custom network and methods', () => {
      const custom = new MPPHandler({
        defaultNetwork: 'tempo-mainnet',
        tempoRpcUrl: 'https://rpc.tempo.test',
        preferredMethods: ['tempo', 'stripe'],
      });
      expect(custom.protocolName).toBe('mpp');
    });
  });
});
