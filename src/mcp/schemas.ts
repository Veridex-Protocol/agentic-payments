/**
 * @packageDocumentation
 * @module MCPSchemas
 * @description
 * JSON Schema definitions for MCP Tool inputs.
 * 
 * These schemas validate the arguments passed by LLMs when invoking Agent tools
 * (e.g., 'amount' must be a string, 'chainId' must be a known number).
 * 
 * Defined Schemas:
 * - `CREATE_SESSION_SCHEMA`: Configuration for new session keys.
 * - `PAY_SCHEMA`: Parameters for cross-chain payments.
 * - `CHECK_BALANCE_SCHEMA`: Arguments for balance queries.
 * - `REVOKE_SESSION_SCHEMA`: Arguments for session revocation.
 */
export const CREATE_SESSION_SCHEMA = {
  type: 'object',
  properties: {
    dailyLimitUSD: { type: 'number' },
    perTransactionLimitUSD: { type: 'number' },
    expiryHours: { type: 'number' },
    allowedChains: { type: 'array', items: { type: 'number' } }
  },
  required: ['dailyLimitUSD', 'perTransactionLimitUSD']
};

export const PAY_SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: 'string', description: 'Amount in ATOMIC UNITS (wei). E.g. 10 USDC = 10000000 (6 decimals), 1 ETH = 10^18.' },
    token: { type: 'string', description: 'Token symbol (e.g. "usdc", "eth", "native")' },
    recipient: { type: 'string', description: 'Recipient wallet address (0x...)' },
    chain: { type: 'number', description: 'Wormhole Chain ID. Use: 10004=Base Sepolia, 10002=Ethereum Sepolia, 10003=Arbitrum Sepolia, 10005=Optimism Sepolia. Do NOT use native chain IDs like 11155111.' }
  },
  required: ['amount', 'recipient', 'chain']
};

export const CHECK_BALANCE_SCHEMA = {
  type: 'object',
  properties: {
    chain: { type: 'number' }
  }
};

export const REVOKE_SESSION_SCHEMA = {
  type: 'object',
  properties: {
    sessionKeyHash: { type: 'string' }
  },
  required: ['sessionKeyHash']
};

export const GET_HISTORY_SCHEMA = {
  type: 'object',
  properties: {
    limit: { type: 'number' },
    offset: { type: 'number' },
    chain: { type: 'number' }
  }
};
