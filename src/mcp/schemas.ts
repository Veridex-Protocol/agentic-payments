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
    amount: { type: 'string' },
    token: { type: 'string' },
    recipient: { type: 'string' },
    chain: { type: 'number' }
  },
  required: ['amount', 'recipient']
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
