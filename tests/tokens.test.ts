import { describe, expect, it } from 'vitest';
import {
  UnknownNetworkError,
  UnknownTokenError,
  isTokenKnown,
  registerToken,
  resolveEvmChainId,
  resolveToken,
} from '../src/x402/tokens';

describe('token resolution', () => {
  describe('FET settlement', () => {
    it('resolves FET on BSC at 18 decimals', () => {
      const fet = resolveToken('FET', 56);
      expect(fet.address).toBe('0x031b41e504677879370e9DBcF937283A8691Fa7f');
      expect(fet.decimals).toBe(18);
    });

    it('does not silently price FET like a stablecoin', () => {
      // The old signer defaulted unknown tokens to 6 decimals. FET is 18: that gap is a
      // factor of 10^12 on every amount, which is the difference between paying 1 FET and
      // paying a trillion.
      const fet = resolveToken('FET', 56);
      const usdc = resolveToken('USDC', 1);
      expect(fet.decimals).not.toBe(usdc.decimals);
      expect(fet.decimals).toBe(18);
    });

    it('is case-insensitive on the symbol', () => {
      expect(resolveToken('fet', 56).decimals).toBe(18);
    });

    it('resolves by address as well as symbol', () => {
      const byAddr = resolveToken('0x031b41e504677879370e9DBcF937283A8691Fa7f', 56);
      expect(byAddr.symbol).toBe('FET');
      expect(byAddr.decimals).toBe(18);
    });
  });

  describe('fails closed', () => {
    it('refuses an unknown symbol instead of defaulting to USDC', () => {
      // Previously this returned the Base USDC address with a console.warn — an agent asking
      // to pay in one token would have moved a different one entirely.
      expect(() => resolveToken('WAGMI', 56)).toThrow(UnknownTokenError);
    });

    it('refuses a known symbol on a chain where it is not deployed', () => {
      // FET has no canonical deployment on BSC testnet.
      expect(() => resolveToken('FET', 97)).toThrow(UnknownTokenError);
    });

    it('refuses an unknown raw address rather than guessing decimals', () => {
      const unknown = '0x1111111111111111111111111111111111111111';
      expect(() => resolveToken(unknown, 56)).toThrow(UnknownTokenError);
    });

    it('names the token and chain in the error', () => {
      expect(() => resolveToken('WAGMI', 56)).toThrow(/WAGMI.*56/s);
    });
  });

  describe('chain resolution', () => {
    it('separates BSC mainnet from BSC testnet via the network string', () => {
      // Wormhole assigns chain id 4 to both. Only the x402 network string tells them apart,
      // so a token resolved from the Wormhole id alone could point at the wrong chain.
      expect(resolveEvmChainId('bsc', 4)).toBe(56);
      expect(resolveEvmChainId('bsc-testnet', 4)).toBe(97);
    });

    it('falls back to the Wormhole id when no network string is given', () => {
      expect(resolveEvmChainId(undefined, 4)).toBe(56);
      expect(resolveEvmChainId(undefined, 30)).toBe(8453);
    });

    it('prefers the network string over the Wormhole id', () => {
      expect(resolveEvmChainId('base', 4)).toBe(8453);
    });

    it('rejects a network it cannot resolve', () => {
      expect(() => resolveEvmChainId('not-a-chain')).toThrow(UnknownNetworkError);
    });
  });

  describe('runtime registration', () => {
    it('registers a testnet FET stand-in', () => {
      // BSC testnet has no canonical FET, so the demo deploys its own and registers it here.
      const addr = '0x2222222222222222222222222222222222222222';
      expect(isTokenKnown('FET', 97)).toBe(false);

      registerToken({ chainId: 97, symbol: 'FET', address: addr, decimals: 18 });

      const fet = resolveToken('FET', 97);
      expect(fet.address).toBe(addr);
      expect(fet.decimals).toBe(18);
      expect(resolveToken(addr, 97).symbol).toBe('FET');
    });

    it('refuses an implausible decimals value', () => {
      expect(() =>
        registerToken({
          chainId: 97,
          symbol: 'BAD',
          address: '0x3333333333333333333333333333333333333333',
          decimals: 99,
        }),
      ).toThrow(/decimals/);
    });
  });
});
