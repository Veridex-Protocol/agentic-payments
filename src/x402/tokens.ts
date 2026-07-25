/**
 * @packageDocumentation
 * @module x402/tokens
 * @description
 * Token resolution for x402 settlement: symbol → (address, decimals), per EVM chain.
 *
 * This module fails closed. An unknown token raises {@link UnknownTokenError} rather than
 * falling back to a default, because the two things it resolves — the contract to pull funds
 * from, and the decimal scale to price them in — are exactly the two things you must never
 * guess. A wrong decimals guess of 6-vs-18 misprices a payment by a factor of 10^12.
 */

/** Resolved token: what to transfer, and at what scale. */
export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

/** Raised when a token cannot be resolved for a chain. Callers should register it. */
export class UnknownTokenError extends Error {
  constructor(token: string, chainId: number) {
    super(
      `Cannot resolve token "${token}" on EVM chain ${chainId}. ` +
        `Refusing to guess its address or decimals — register it first with ` +
        `registerToken({ chainId: ${chainId}, symbol: "${token}", address, decimals }).`,
    );
    this.name = 'UnknownTokenError';
  }
}

/** Raised when a network string cannot be mapped to an EVM chain. */
export class UnknownNetworkError extends Error {
  constructor(network: string) {
    super(`Cannot resolve x402 network "${network}" to an EVM chain id.`);
    this.name = 'UnknownNetworkError';
  }
}

/**
 * x402 `network` string → EVM chain id.
 *
 * The network string is load-bearing on BNB Chain specifically: Wormhole assigns chain id 4
 * to BSC mainnet *and* BSC testnet, so the Wormhole id alone cannot tell them apart, and a
 * token resolved from it would silently point at the wrong chain's contract.
 */
const NETWORK_TO_EVM_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  'ethereum-mainnet': 1,
  mainnet: 1,
  base: 8453,
  'base-mainnet': 8453,
  'base-sepolia': 84532,
  arbitrum: 42161,
  'arbitrum-one': 42161,
  'arbitrum-sepolia': 421614,
  optimism: 10,
  'optimism-sepolia': 11155420,
  polygon: 137,
  avalanche: 43114,
  'avalanche-fuji': 43113,
  sepolia: 11155111,
  'ethereum-sepolia': 11155111,
  bsc: 56,
  'bsc-mainnet': 56,
  binance: 56,
  'bnb-chain': 56,
  'bsc-testnet': 97,
  'bnb-testnet': 97,
};

/** Wormhole chain id → EVM chain id. Mainnet only; testnets must go through `network`. */
const WORMHOLE_TO_EVM_CHAIN_ID: Record<number, number> = {
  2: 1, // Ethereum
  4: 56, // BSC — note: Wormhole reuses 4 for BSC testnet, hence the network-string path
  5: 137, // Polygon
  6: 43114, // Avalanche
  23: 42161, // Arbitrum
  24: 10, // Optimism
  25: 25, // Cronos
  30: 8453, // Base
  10002: 11155111, // Ethereum Sepolia
  10004: 84532, // Base Sepolia
  10025: 338, // Cronos Testnet
};

const key = (chainId: number, symbol: string) => `${chainId}:${symbol.toUpperCase()}`;

/** symbol-keyed registry */
const bySymbol = new Map<string, TokenInfo>();
/** address-keyed registry, for resolving decimals when the caller passes a raw address */
const byAddress = new Map<string, TokenInfo>();

/** Register (or override) a token. Idempotent. */
export function registerToken(token: TokenInfo & { chainId: number }): void {
  const info: TokenInfo = {
    symbol: token.symbol.toUpperCase(),
    address: token.address,
    decimals: token.decimals,
  };
  if (!Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 36) {
    throw new Error(`Refusing to register ${info.symbol} with implausible decimals ${info.decimals}`);
  }
  bySymbol.set(key(token.chainId, info.symbol), info);
  byAddress.set(key(token.chainId, info.address), info);
}

function seed(chainId: number, symbol: string, address: string, decimals: number) {
  registerToken({ chainId, symbol, address, decimals });
}

// ── USDC ────────────────────────────────────────────────────────
seed(1, 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6);
seed(8453, 'USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6);
seed(42161, 'USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6);
seed(10, 'USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6);
seed(25, 'USDC', '0xf951eC28187D9E5Ca673Da8FE6757E6f0Be5F77C', 6);
seed(11155111, 'USDC', '0x7A7754A2089df825801A0a8d95a9801928bFb22A', 6);
seed(338, 'USDC', '0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0', 6);

// ── FET (Fetch.ai) ──────────────────────────────────────────────
// BEP-20 FET is 18 decimals, unlike the 6-decimal stablecoins that dominate x402 today.
// https://bscscan.com/token/0x031b41e504677879370e9dbcf937283a8691fa7f
seed(56, 'FET', '0x031b41e504677879370e9DBcF937283A8691Fa7f', 18);
// BSC testnet has no canonical FET. The demo deploys its own 18-decimal stand-in and
// registers it at runtime — see registerToken() in @veridex/fetch-adapter.

/** Resolve an x402 `network` string (preferred) or Wormhole chain id to an EVM chain id. */
export function resolveEvmChainId(network?: string, wormholeChainId?: number): number {
  if (network) {
    const fromNetwork = NETWORK_TO_EVM_CHAIN_ID[network.toLowerCase()];
    if (fromNetwork) return fromNetwork;
  }
  if (wormholeChainId !== undefined) {
    const fromWormhole = WORMHOLE_TO_EVM_CHAIN_ID[wormholeChainId];
    if (fromWormhole) return fromWormhole;
    // Some callers already pass an EVM chain id here.
    if (wormholeChainId > 100) return wormholeChainId;
  }
  throw new UnknownNetworkError(network ?? String(wormholeChainId));
}

/**
 * Resolve a token symbol or address on a chain.
 * @throws {UnknownTokenError} if the token is not registered — never guesses.
 */
export function resolveToken(token: string, chainId: number): TokenInfo {
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(token);
  const found = isAddress
    ? byAddress.get(key(chainId, token))
    : bySymbol.get(key(chainId, token));

  if (found) return found;
  throw new UnknownTokenError(token, chainId);
}

/** Whether a token is resolvable on a chain, without throwing. */
export function isTokenKnown(token: string, chainId: number): boolean {
  try {
    resolveToken(token, chainId);
    return true;
  } catch {
    return false;
  }
}
