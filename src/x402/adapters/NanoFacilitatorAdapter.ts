/**
 * @packageDocumentation
 * @module NanoFacilitatorAdapter
 * @description
 * Adapter for Nano (XNO) x402 settlement inside Veridex agentic-payments.
 *
 * Nano is a feeless, sub-second, serverless payment rail: there is no smart-contract
 * layer, no gas and no third-party facilitator to trust — a payment is proven by the
 * block existing on the Nano ledger. This adapter verifies and settles Nano x402
 * payments by querying the Nano node's RPC (`block_info`, `account_info`), so a paid
 * endpoint and its payer never have to pass through a custody or off-chain batching
 * layer.
 *
 * Supports both `exact` and `upto` Nano schemes.
 * Network identifier: `nano:mainnet` (and `nano:test` where a test network is reachable).
 *
 * Reuses the Nano node RPC (rpc.nano.to or any public Nano node) as the building block;
 * it never invents a Nano client from scratch.
 *
 * A Nano block has no memo: a confirmed send proves that an amount reached an account and
 * nothing about WHICH order it paid. The adapter therefore binds a block to one issued
 * order. `issueOrder` returns an opaque random `orderId`, the pay-to account and an exact
 * amount carrying a per-order tag no other open order shares, inside an issue/expiry
 * window. `verify`/`settle` read that order from the `NanoOrderStore` (never from caller
 * input), require the payload's `orderId`, check the block is a confirmed send of exactly
 * that amount to exactly that account made inside the window, and claim
 * `blockHash -> orderId` once (UNIQUE on both). The default store is in memory (tests,
 * one process); a seller that restarts or runs several workers passes a database-backed
 * store. Node lookups time out, cap the response size, and refuse plain-HTTP RPC URLs
 * unless they are loopback.
 */

import type {
  Payment402Request,
  Payment402Response,
  PaymentSettlementResponse,
} from '../../types/x402';
import { AgentPaymentError, AgentPaymentErrorCode } from '../../types/errors';

// ---------------------------------------------------------------------------
// Network constants
// ---------------------------------------------------------------------------

/** CAIP-2-style identifiers for Nano networks. */
export const NANO_NETWORKS = {
  mainnet: 'nano:mainnet',
  test: 'nano:test',
} as const;

/** XNO raw units per whole Nano (10^30 raw in 1 XNO). */
export const NANO_RAW_PER_XNO = 10n ** 30n;

/** Default Nano node RPC endpoint (public, feeless, no auth). */
export const NANO_DEFAULT_RPC = 'https://rpc.nano.to';

/** Resolve a raw network string to a Nano network identifier. */
export function toNanoNetwork(network: string): string {
  if (network.startsWith('nano:')) return network;
  if (network === 'mainnet') return NANO_NETWORKS.mainnet;
  if (network === 'test' || network === 'testnet') return NANO_NETWORKS.test;
  return network;
}

/** Whether a network identifier refers to a Nano network. */
export function isNanoNetwork(network: string): boolean {
  return network.startsWith('nano:') || network === 'mainnet';
}

/** Convert an XNO decimal string (e.g. "0.001") to raw units. */
export function xnoToRaw(xno: string | number): string {
  const text = String(xno).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`not a decimal XNO amount: ${text}`);
  }
  const [whole = '0', frac = ''] = text.split('.');
  if (frac.length > 30) {
    throw new Error(`more than 30 decimal places: ${text}`);
  }
  return (BigInt(whole) * NANO_RAW_PER_XNO + BigInt((frac + '0'.repeat(30)).slice(0, 30))).toString();
}

/** Convert raw units to an XNO decimal string. */
export function rawToXno(raw: string): string {
  const rawBig = BigInt(raw);
  const whole = rawBig / NANO_RAW_PER_XNO;
  const fraction = rawBig % NANO_RAW_PER_XNO;
  const fracStr = fraction.toString().padStart(30, '0');
  return fraction === 0n ? whole.toString() : `${whole.toString()}.${fracStr.replace(/0+$/, '')}`;
}

// ---------------------------------------------------------------------------
// Orders and the claim store
// ---------------------------------------------------------------------------

/** Each order adds a random tag of 1..NANO_TAG_SPAN-1 raw to its price (10^6 raw = 10^-24 XNO). */
const NANO_TAG_SPAN = 1_000_000n;
const NANO_TAG_ATTEMPTS = 64;
/** Node and seller clocks may differ a little; the window check tolerates this much. */
const NANO_CLOCK_SKEW_MS = 30_000;
const NANO_DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const NANO_BLOCK_HASH = /^[0-9A-F]{64}$/;

export interface NanoOrder {
  /** Opaque random id (128 bits): the requester's claim secret, never a counter. */
  orderId: string;
  /** Nano account the buyer must pay. */
  payTo: string;
  /** Exact raw amount, tag included. */
  amountRaw: string;
  /** Issue time, ms since epoch. A block made earlier cannot pay this order. */
  issuedAtMs: number;
  /** Expiry, ms since epoch. A block made later cannot pay this order. */
  expiresAtMs: number;
}

/**
 * Where orders and claimed blocks live. Every method must be atomic. A persistent
 * implementation keeps `claims(block_hash UNIQUE, order_id UNIQUE)`.
 */
export interface NanoOrderStore {
  /** Store the order unless a not-yet-expired order holds the same payTo and amountRaw. */
  put(order: NanoOrder, nowMs: number): Promise<boolean>;
  get(orderId: string): Promise<NanoOrder | undefined>;
  /**
   * Record `blockHash -> orderId`. True when this exact pair is already recorded
   * (idempotent re-read) or was just recorded; false when the hash belongs to another
   * order or the order already has a different block.
   */
  claim(blockHash: string, orderId: string): Promise<boolean>;
}

/** In-memory store: one process, lost on restart. Use a database-backed store in production. */
export class InMemoryNanoOrderStore implements NanoOrderStore {
  private orders = new Map<string, NanoOrder>();
  private byBlock = new Map<string, string>();
  private byOrder = new Map<string, string>();

  async put(order: NanoOrder, nowMs: number): Promise<boolean> {
    for (const held of this.orders.values()) {
      if (held.payTo === order.payTo && held.amountRaw === order.amountRaw && held.expiresAtMs > nowMs) {
        return false;
      }
    }
    this.orders.set(order.orderId, { ...order });
    return true;
  }

  async get(orderId: string): Promise<NanoOrder | undefined> {
    const order = this.orders.get(orderId);
    return order ? { ...order } : undefined;
  }

  async claim(blockHash: string, orderId: string): Promise<boolean> {
    const owner = this.byBlock.get(blockHash);
    const held = this.byOrder.get(orderId);
    if (owner !== undefined || held !== undefined) {
      return owner === orderId && held === blockHash;
    }
    this.byBlock.set(blockHash, orderId);
    this.byOrder.set(orderId, blockHash);
    return true;
  }
}

/** Refuse plain-HTTP RPC endpoints unless they are loopback. */
export function assertSafeNanoRpcUrl(rpcUrl: string): void {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error(`invalid Nano rpc url: ${rpcUrl}`);
  }
  if (url.protocol === 'https:') return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (url.protocol === 'http:' && loopback) return;
  throw new Error('Nano rpc url must be https (plain http only on loopback)');
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomTag(): bigint {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return 1n + (BigInt(buf[0] as number) % (NANO_TAG_SPAN - 1n));
}

async function readBounded(response: Response, maxBytes: number): Promise<any> {
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('Nano rpc response too large');
  const reader = (response as any).body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Nano rpc response too large');
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(all));
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error('Nano rpc response too large');
    return JSON.parse(text);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface NanoFacilitatorConfig {
  /** Nano node RPC URL. Default: rpc.nano.to (public, no auth). https, or http on loopback only. */
  rpcUrl?: string;
  /** Nano network. Default: 'nano:mainnet'. */
  network?: string;
  /** Timeout for RPC requests in ms. Default: 15000. */
  timeoutMs?: number;
  /** Largest RPC response accepted, in bytes. Default: 65536. */
  maxResponseBytes?: number;
  /** Orders and claimed blocks. Default: in memory (one process, lost on restart). */
  store?: NanoOrderStore;
  /** Clock in ms since epoch; tests only. */
  clock?: () => number;
}

// ---------------------------------------------------------------------------
// NanoFacilitatorAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter that verifies and settles Nano (XNO) x402 payments against a Nano node.
 *
 * Because Nano settlement is on-ledger and feeless, `verify` and `settle` both read
 * the node — the block's existence *is* the proof of payment. There is no custodial
 * facilitator to trust, so this adapter is the entire settlement leg.
 *
 * @example
 * ```typescript
 * const nano = new NanoFacilitatorAdapter({ network: 'nano:mainnet' });
 *
 * // In a custom paywall:
 * const isValid = await nano.verify(paymentRequest, paymentResponse);
 * if (isValid) await nano.settle(paymentRequest, paymentResponse);
 * ```
 */
export class NanoFacilitatorAdapter {
  private rpcUrl: string;
  private network: string;
  private timeoutMs: number;
  private maxResponseBytes: number;
  private store: NanoOrderStore;
  private clock: () => number;

  constructor(config: NanoFacilitatorConfig = {}) {
    this.rpcUrl = (config.rpcUrl || NANO_DEFAULT_RPC).replace(/\/$/, '');
    assertSafeNanoRpcUrl(this.rpcUrl);
    this.network = config.network || NANO_NETWORKS.mainnet;
    this.timeoutMs = config.timeoutMs || 15000;
    this.maxResponseBytes = config.maxResponseBytes || NANO_DEFAULT_MAX_RESPONSE_BYTES;
    this.store = config.store ?? new InMemoryNanoOrderStore();
    this.clock = config.clock ?? Date.now;
  }

  /**
   * Issue one order for a price. Give the requester `orderId`, `payTo` and `amountRaw`
   * (put `amountRaw` in `maxAmountRequired`); the requester presents `orderId` and the
   * block hash in the payment payload. Throws if no free tagged amount is found.
   */
  async issueOrder(params: {
    recipient: string;
    priceRaw?: string;
    priceXNO?: string;
    ttlMs?: number;
  }): Promise<NanoOrder> {
    if (!params.recipient) throw new Error('recipient is required');
    const price = BigInt(params.priceRaw ?? xnoToRaw(params.priceXNO ?? ''));
    if (price <= 0n) throw new Error('price must be positive');
    const ttlMs = params.ttlMs ?? 15 * 60_000;
    if (!(ttlMs > 0)) throw new Error('ttlMs must be positive');
    const now = this.clock();
    for (let i = 0; i < NANO_TAG_ATTEMPTS; i++) {
      const order: NanoOrder = {
        orderId: randomHex(16),
        payTo: params.recipient,
        amountRaw: (price + randomTag()).toString(),
        issuedAtMs: now,
        expiresAtMs: now + ttlMs,
      };
      if (await this.store.put(order, now)) return order;
    }
    throw new Error('no free amount for this price and account');
  }

  /** Whether this adapter can handle a given payment request. */
  canHandle(request: Payment402Request): boolean {
    const network = request.network || '';
    const scheme = (request.scheme as string) || '';
    return (
      isNanoNetwork(network) ||
      scheme === 'exact_nano' ||
      scheme === 'upto_nano'
    );
  }

  /** Nano network identifier for the configured network. */
  getNetwork(): string {
    return toNanoNetwork(this.network);
  }

  /**
   * Verify a Nano x402 payment against the order it names.
   *
   * The payment payload carries the `orderId` issued by `issueOrder` and the Nano block
   * hash the payer sent. The order is read from the store; `block_info` must show a
   * confirmed send of exactly the order's amount to exactly its account, made inside the
   * order's window, and `blockHash -> orderId` is claimed once (idempotent for the same
   * pair, refused for any other).
   *
   * @returns true if the block pays this order and is not claimed by another
   */
  async verify(
    request: Payment402Request,
    response: Payment402Response,
  ): Promise<boolean> {
    try {
      await this.check(request, response);
      return true;
    } catch (err: any) {
      console.warn(`[NanoFacilitator] Verify failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Settle a verified Nano x402 payment.
   *
   * Nano requires no extra settlement call - the on-ledger block already settled it - but
   * settle re-runs the same order-bound check (it never trusts that `verify` was called),
   * so it cannot settle an unconfirmed, unbound or replayed block.
   *
   * @returns Settlement result with the Nano block hash
   */
  async settle(
    request: Payment402Request,
    response: Payment402Response,
  ): Promise<PaymentSettlementResponse> {
    const payload = this.parsePayload(response);
    const rawHash = payload?.blockHash || payload?.transactionHash ||
      response.txHash || response.signature || '';

    if (!rawHash) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        'Nano settlement failed: no block hash in the payment payload.',
        'The payer must include the submitted Nano block hash in the x402 payload.',
        false,
      );
    }

    try {
      const blockHash = await this.check(request, response);
      return {
        success: true,
        transactionHash: blockHash,
        network: this.getNetwork(),
        amount: request.amount,
        facilitator: 'nano:ledger',
      };
    } catch (err: any) {
      throw new AgentPaymentError(
        AgentPaymentErrorCode.PAYMENT_FAILED,
        `Nano settlement rejected: ${err.message}`,
        'Check the order id, the block hash, and that the block is confirmed.',
        true,
      );
    }
  }

  /** Supported capabilities of this adapter. */
  getCapabilities(): { assets: string[]; network: string; schemes: string[] } {
    return {
      assets: ['XNO', 'nano'],
      network: this.getNetwork(),
      schemes: ['exact', 'exact_nano', 'upto', 'upto_nano'],
    };
  }

  // --------------------------------------------------------------------------

  private parsePayload(response: Payment402Response): Record<string, any> {
    if (!response?.paymentPayload) return {};
    try {
      const parsed = JSON.parse(response.paymentPayload);
      return parsed?.payload || parsed || {};
    } catch {
      return {};
    }
  }

  private matchesNetwork(requestNetwork?: string): boolean {
    if (!requestNetwork) return true;
    return isNanoNetwork(requestNetwork);
  }

  /** The order-bound check shared by verify and settle. Returns the canonical block hash. */
  private async check(request: Payment402Request, response: Payment402Response): Promise<string> {
    const payload = this.parsePayload(response);
    const rawHash = payload?.blockHash || payload?.transactionHash ||
      response.txHash || response.signature || '';
    const blockHash = typeof rawHash === 'string' ? rawHash.trim().toUpperCase() : '';
    if (!NANO_BLOCK_HASH.test(blockHash)) throw new Error('block hash is not 64 hex digits');
    const orderId = payload?.orderId;
    if (typeof orderId !== 'string' || !orderId) throw new Error('payload has no orderId');
    if (!this.matchesNetwork(request.network)) throw new Error('not a Nano network');

    const order = await this.store.get(orderId);
    if (!order) throw new Error('unknown order');
    const now = this.clock();
    if (now >= order.expiresAtMs) throw new Error('order expired');
    // The request is only a cross-check; the amount and account come from the order.
    if (request.amount && String(request.amount) !== order.amountRaw) throw new Error('request amount differs from the order');
    if (request.recipient && request.recipient !== order.payTo) throw new Error('request recipient differs from the order');

    const info = await this.rpc('block_info', { hash: blockHash, json_block: 'true' });
    if (info?.confirmed !== true && info?.confirmed !== 'true') throw new Error('block is not confirmed');
    const block = info?.contents;
    if (!block || typeof block !== 'object') throw new Error('node returned no block contents');
    if (info.subtype !== 'send' && block.type !== 'send') throw new Error('block is not a send');
    // block_info reports the transferred amount at the top level, not inside contents.
    if (!/^\d+$/.test(String(info.amount ?? '')) || String(info.amount) !== order.amountRaw) {
      throw new Error('block amount differs from the order');
    }
    if ((block.link_as_account ?? block.destination) !== order.payTo) {
      throw new Error('block recipient differs from the order');
    }
    // The block's own time must sit inside the order's window, so a late block for an
    // expired order cannot pay a newer order that was handed the same amount.
    const blockMs = Number(String(info.local_timestamp ?? '')) * 1000;
    if (!Number.isFinite(blockMs) || blockMs <= 0) throw new Error('block has no usable local_timestamp');
    if (blockMs < order.issuedAtMs - NANO_CLOCK_SKEW_MS || blockMs > order.expiresAtMs + NANO_CLOCK_SKEW_MS) {
      throw new Error('block was not made inside the order window');
    }
    if (!(await this.store.claim(blockHash, order.orderId))) {
      throw new Error('block already claimed, or order already paid by another block');
    }
    return blockHash;
  }

  private async rpc(action: 'block_info', params: Record<string, any>): Promise<any> {
    const body = { action, ...params };
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const result = await readBounded(response, this.maxResponseBytes);
    if (result?.error) {
      throw new Error(String(result.error));
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

/**
 * Verify a Nano x402 payment without instantiating the full adapter. `options.store`
 * must be the store the order was issued in.
 */
export async function verifyNanoPayment(
  blockHash: string,
  requirements: {
    network: string;
    maxAmountRequired: string;
    payTo: string;
    /** Order id from `issueOrder`; a block hash alone is never a proof. */
    orderId: string;
  },
  options: { rpcUrl?: string; store: NanoOrderStore },
): Promise<{ isValid: boolean; error?: string }> {
  const adapter = new NanoFacilitatorAdapter({
    rpcUrl: options.rpcUrl,
    store: options.store,
    network: requirements.network,
  });
  const req: Payment402Request = {
    amount: requirements.maxAmountRequired,
    token: 'XNO',
    recipient: requirements.payTo,
    chain: 0,
    network: requirements.network,
    scheme: 'exact',
    original: requirements as any,
  };
  try {
    const isValid = await adapter.verify(req, {
      signature: '',
      nonce: '',
      deadline: 0,
      paymentPayload: JSON.stringify({ payload: { blockHash, orderId: requirements.orderId } }),
    });
    return { isValid };
  } catch (err: any) {
    return { isValid: false, error: err.message };
  }
}

/**
 * Build Nano x402 payment requirements for a paywall.
 */
export function buildNanoPaymentRequirements(params: {
  priceXNO: string;
  recipientAddress: string;
  network?: string;
  scheme?: 'exact' | 'upto';
  description?: string;
  /** An order from `issueOrder`: its tagged amount and account replace the price, and its id goes in `extra`. */
  order?: NanoOrder;
}) {
  const network = toNanoNetwork(params.network || 'nano:mainnet');
  return {
    scheme: params.scheme || 'exact',
    network,
    maxAmountRequired: params.order ? params.order.amountRaw : xnoToRaw(params.priceXNO),
    asset: 'XNO',
    payTo: params.order ? params.order.payTo : params.recipientAddress,
    description: params.description || 'Nano x402 payment',
    ...(params.order ? { extra: { orderId: params.order.orderId, expiresAtMs: params.order.expiresAtMs } } : {}),
  };
}
