/**
 * Tests for SettlementVerifier (Phase 4.2)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SettlementVerifier,
  EVMSettlementStrategy,
} from '../src/protocols/base/SettlementVerifier';
import type { PaymentSettlement } from '../src/protocols/base/types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockSettlement(overrides?: Partial<PaymentSettlement>): PaymentSettlement {
  return {
    success: true,
    protocol: 'x402',
    txHash: '0xabc123def456',
    network: '2',
    amount: '1000000',
    token: 'USDC',
    settledAt: Date.now(),
    ...overrides,
  };
}

describe('SettlementVerifier', () => {
  let verifier: SettlementVerifier;

  beforeEach(() => {
    verifier = new SettlementVerifier();
    mockFetch.mockReset();
  });

  it('should return null for unsuccessful settlements', async () => {
    const settlement = createMockSettlement({ success: false });
    const proof = await verifier.verify(settlement);
    expect(proof).toBeNull();
  });

  it('should return null for settlements without txHash', async () => {
    const settlement = createMockSettlement({ txHash: undefined });
    const proof = await verifier.verify(settlement);
    expect(proof).toBeNull();
  });

  it('should return basic proof when no strategy registered', async () => {
    const settlement = createMockSettlement();
    const proof = await verifier.verify(settlement);
    expect(proof).not.toBeNull();
    expect(proof!.txHash).toBe('0xabc123def456');
    expect(proof!.traceHashInCalldata).toBe(false);
    expect(proof!.chain).toBe(2);
  });

  it('should use registered strategy for verification', async () => {
    const mockStrategy = {
      protocol: 'x402' as const,
      verify: vi.fn().mockResolvedValue({
        txHash: '0xabc123def456',
        blockNumber: 12345,
        traceHashInCalldata: true,
        chain: 2,
      }),
    };

    verifier.registerStrategy(mockStrategy);
    const settlement = createMockSettlement();
    const proof = await verifier.verify(settlement, '0xtrace');

    expect(proof).not.toBeNull();
    expect(proof!.blockNumber).toBe(12345);
    expect(proof!.traceHashInCalldata).toBe(true);
    expect(mockStrategy.verify).toHaveBeenCalledWith(settlement, '0xtrace');
  });

  it('should fall back to basic proof on strategy failure', async () => {
    const mockStrategy = {
      protocol: 'x402' as const,
      verify: vi.fn().mockRejectedValue(new Error('RPC failed')),
    };

    verifier.registerStrategy(mockStrategy);
    const settlement = createMockSettlement();
    const proof = await verifier.verify(settlement);

    expect(proof).not.toBeNull();
    expect(proof!.txHash).toBe('0xabc123def456');
    expect(proof!.traceHashInCalldata).toBe(false);
  });

  it('should check if strategy exists', () => {
    expect(verifier.hasStrategy('x402')).toBe(false);
    verifier.registerStrategy({
      protocol: 'x402',
      verify: vi.fn(),
    });
    expect(verifier.hasStrategy('x402')).toBe(true);
  });

  it('should return RPC endpoint for chain', () => {
    const v = new SettlementVerifier({
      rpcEndpoints: { 2: 'https://eth.rpc.test' },
    });
    expect(v.getRpcEndpoint(2)).toBe('https://eth.rpc.test');
    expect(v.getRpcEndpoint(99)).toBeUndefined();
  });
});

describe('EVMSettlementStrategy', () => {
  let strategy: EVMSettlementStrategy;

  beforeEach(() => {
    strategy = new EVMSettlementStrategy('x402', {
      2: 'https://eth.rpc.test',
    });
    mockFetch.mockReset();
  });

  it('should return null without txHash', async () => {
    const settlement = createMockSettlement({ txHash: undefined });
    const proof = await strategy.verify(settlement);
    expect(proof).toBeNull();
  });

  it('should return basic proof without RPC endpoint', async () => {
    const settlement = createMockSettlement({ network: '999' });
    const proof = await strategy.verify(settlement);
    expect(proof).not.toBeNull();
    expect(proof!.txHash).toBe('0xabc123def456');
    expect(proof!.traceHashInCalldata).toBe(false);
  });

  it('should verify via JSON-RPC', async () => {
    // Mock getTransactionReceipt
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        result: {
          blockNumber: '0x3039', // 12345
          status: '0x1',
        },
      }),
    });

    const settlement = createMockSettlement();
    const proof = await strategy.verify(settlement);

    expect(proof).not.toBeNull();
    expect(proof!.blockNumber).toBe(12345);
    expect(proof!.traceHashInCalldata).toBe(false);
  });

  it('should return null for failed transaction', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        result: {
          blockNumber: '0x3039',
          status: '0x0', // reverted
        },
      }),
    });

    const settlement = createMockSettlement();
    const proof = await strategy.verify(settlement);
    expect(proof).toBeNull();
  });

  it('should check for traceHash in calldata', async () => {
    // Mock getTransactionReceipt
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        result: {
          blockNumber: '0x3039',
          status: '0x1',
        },
      }),
    });

    // Mock getTransactionByHash
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        result: {
          input: '0x00000000abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        },
      }),
    });

    const settlement = createMockSettlement();
    const proof = await strategy.verify(
      settlement,
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );

    expect(proof).not.toBeNull();
    expect(proof!.traceHashInCalldata).toBe(true);
  });

  it('should handle missing receipt', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ result: null }),
    });

    const settlement = createMockSettlement();
    const proof = await strategy.verify(settlement);
    expect(proof).toBeNull();
  });
});
