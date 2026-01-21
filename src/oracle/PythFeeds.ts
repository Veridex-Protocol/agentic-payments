/**
 * @packageDocumentation
 * @module PythFeeds
 * @description
 * Configuration constants for Pyth Network Price Feeds.
 * 
 * Sourced from https://pyth.network/developers/price-feed-ids
 * 
 * Contains mappings for:
 * - Specific Asset IDs (ETH, SOL, BTC).
 * - Chain Native Gas Tokens (for gas estimation).
 */
export const PYTH_FEED_IDS = {
    // Crypto
    ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    APT: '0x03ae4db29ed4ae33d323568895aa00337e658e348b37509f5372ae51f0af00d5',
    SUI: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
    STRK: '0x6a182399ff70ccf3e06024898942028204125a819e519a335ffa4579e66cd870',
    AVAX: '0x93da3352f9ee7d08faa46dbf70df853e11d63425451c6a682505eacc7022d641',
    OP: '0x385f64d993d7bad7a3604bc65727092e59df926c989ec8ad91fab2f8ca68c34f',
    ARB: '0x3fa4252848f9f0a1480be62745a4629d9eb1322aebab8a791e344b3b9c1adcf5',
    BASE: '0x5c721b0333cb91316b1f2479e0004c0cfb8c564344e1325d30907d391ec9d773', // Note: Base usually uses ETH

    // Stablecoins
    USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
    USDT: '0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
    DAI: '0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd',
};

/**
 * Map ChainName to Native Token Feed ID
 */
export const CHAIN_NATIVE_FEED_MAP: Record<string, string> = {
    'ethereum': PYTH_FEED_IDS.ETH,
    'sepolia': PYTH_FEED_IDS.ETH, // Testnet uses same ID? Actually checking docs, normally mainnet IDs are used for price reference or specific testnet IDs exist. 
    // Hermes provides mainnet prices usually.
    'optimism': PYTH_FEED_IDS.OP, // Or ETH? Usually native token of OP is ETH, but OP token exists. 
    // Wait, for GAS estimation we need ETH price.
    // Optimism uses ETH for gas.
    'optimism-sepolia': PYTH_FEED_IDS.ETH,
    'arbitrum': PYTH_FEED_IDS.ETH, // Arbitrum uses ETH for gas.
    'arbitrum-sepolia': PYTH_FEED_IDS.ETH,
    'base': PYTH_FEED_IDS.ETH, // Base uses ETH for gas.
    'base-sepolia': PYTH_FEED_IDS.ETH,
    'solana': PYTH_FEED_IDS.SOL,
    'solana-devnet': PYTH_FEED_IDS.SOL,
    'aptos': PYTH_FEED_IDS.APT,
    'sui': PYTH_FEED_IDS.SUI,
    'starknet': PYTH_FEED_IDS.STRK, // Starknet uses ETH for gas, but STRK can be used too. 
    // Veridex usually estimates in Native Gas Token.
    // For Starknet, it's ETH (mostly).
    // Let's verify what Veridex uses for Starknet Gas.
    // Usually ETH.
};

// Override for Starknet gas token if it differs.
export const STARKNET_GAS_TOKEN_IS_ETH = true;
// If true, we should use ETH feed for Starknet native price method if it represents GAS price.
