/**
 * Tests for Protocol Capability Registry (Phase 4.3)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ProtocolRegistry } from '../src/protocols/base/ProtocolRegistry';
import type { ProtocolCapabilities, ProtocolCapability } from '../src/protocols/base/ProtocolRegistry';

function createX402Caps(): ProtocolCapabilities {
  return {
    protocol: 'x402',
    displayName: 'x402 (Coinbase)',
    capabilities: new Set<ProtocolCapability>([
      'one_time_payment',
      'eip712_signing',
      'gasless',
    ]),
    chains: [
      { chainId: 2, name: 'Ethereum', testnet: false },
      { chainId: 30, name: 'Base', testnet: false },
    ],
    tokens: ['USDC', 'WETH'],
    settlementTimeSec: 15,
  };
}

function createUCPCaps(): ProtocolCapabilities {
  return {
    protocol: 'ucp',
    displayName: 'Universal Commerce Protocol',
    capabilities: new Set<ProtocolCapability>([
      'one_time_payment',
      'subscription',
      'streaming',
      'multi_token',
      'cross_chain',
      'refund',
    ]),
    chains: [
      { chainId: 2, name: 'Ethereum', testnet: false },
      { chainId: 30, name: 'Base', testnet: false },
      { chainId: 1, name: 'Solana', testnet: false },
    ],
    tokens: [],
    settlementTimeSec: 10,
  };
}

function createMPPCaps(): ProtocolCapabilities {
  return {
    protocol: 'mpp',
    displayName: 'Micropayments Protocol (Tempo)',
    capabilities: new Set<ProtocolCapability>([
      'one_time_payment',
      'streaming',
      'metered_billing',
      'prepaid_session',
    ]),
    chains: [
      { chainId: 0, name: 'Tempo', testnet: false },
    ],
    tokens: ['USDC', 'USDT'],
    minAmountUSD: 0.001,
    maxAmountUSD: 1000,
    settlementTimeSec: 2,
  };
}

describe('ProtocolRegistry', () => {
  let registry: ProtocolRegistry;

  beforeEach(() => {
    registry = new ProtocolRegistry();
    registry.register(createX402Caps());
    registry.register(createUCPCaps());
    registry.register(createMPPCaps());
  });

  it('should register and get capabilities', () => {
    expect(registry.get('x402')).toBeDefined();
    expect(registry.get('x402')!.displayName).toBe('x402 (Coinbase)');
    expect(registry.get('unknown' as any)).toBeUndefined();
  });

  it('should list all registered protocols', () => {
    const all = registry.listAll();
    expect(all).toHaveLength(3);
  });

  it('should find by capabilities', () => {
    const streaming = registry.findByCapabilities(['streaming']);
    expect(streaming).toHaveLength(2); // UCP and MPP
    expect(streaming.map((c) => c.protocol).sort()).toEqual(['mpp', 'ucp']);
  });

  it('should find by multiple required capabilities', () => {
    const result = registry.findByCapabilities(['streaming', 'refund']);
    expect(result).toHaveLength(1);
    expect(result[0].protocol).toBe('ucp');
  });

  it('should return empty for impossible capability combination', () => {
    const result = registry.findByCapabilities(['streaming', 'eip712_signing']);
    expect(result).toHaveLength(0);
  });

  it('should find by chain', () => {
    const ethereumProtocols = registry.findByChain(2);
    expect(ethereumProtocols).toHaveLength(2); // x402 and UCP
  });

  it('should find best protocol with all filters', () => {
    const results = registry.findBest({
      capabilities: ['one_time_payment'],
      chainId: 2,
      token: 'USDC',
    });
    // Both x402 and UCP support one_time_payment on Ethereum with USDC
    expect(results.length).toBeGreaterThanOrEqual(1);
    // UCP should come first (more capabilities)
    expect(results[0].protocol).toBe('ucp');
  });

  it('should filter by amount bounds', () => {
    const results = registry.findBest({
      amountUSD: 5000, // Above MPP max of 1000
    });
    // MPP should be filtered out
    const protocols = results.map((r) => r.protocol);
    expect(protocols).not.toContain('mpp');
  });

  it('should filter by token', () => {
    const results = registry.findBest({
      token: 'WETH',
    });
    // Only x402 supports WETH; UCP has empty tokens (= any)
    const protocols = results.map((r) => r.protocol);
    expect(protocols).toContain('x402');
    expect(protocols).toContain('ucp'); // empty tokens = any
    expect(protocols).not.toContain('mpp'); // MPP only has USDC, USDT
  });

  it('should check capability support', () => {
    expect(registry.supports('x402', 'eip712_signing')).toBe(true);
    expect(registry.supports('x402', 'streaming')).toBe(false);
    expect(registry.supports('ucp', 'refund')).toBe(true);
    expect(registry.supports('mpp', 'metered_billing')).toBe(true);
  });

  it('should return false for unregistered protocol', () => {
    expect(registry.supports('direct', 'one_time_payment')).toBe(false);
  });
});
