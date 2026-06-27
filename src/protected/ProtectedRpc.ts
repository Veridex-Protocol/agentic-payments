/**
 * @module @veridex/agentic-payments/protected/ProtectedRpc
 *
 * Closes the **hardened settlement gateway** gap (agent_fabric_gap_analysis.md,
 * Gap 4). Broadcasting agent transactions to a generic public RPC exposes them
 * to mempool eavesdropping, frontrunning, and sandwich attacks.
 *
 * Rather than bake in one MEV-protection vendor, this module lets integrators
 * **bring their own protected RPC**. For a given chain they may supply:
 *
 * - a protected RPC **URL** (Flashbots Protect, MEV-Blocker, bloXroute, a
 *   private node), or
 * - a fully-constructed **provider**, or
 * - a custom **submit** hook for relay/bundle APIs that aren't plain JSON-RPC.
 *
 * When nothing is configured for a chain, behavior is unchanged: the default
 * public RPC is used. The seam is opt-in and backward compatible.
 */

import { ethers } from 'ethers';

/** Context handed to a custom protected-submit hook. */
export interface ProtectedSubmitContext {
  /** Chain identifier (the same id the caller routes on). */
  chain: number;
}

/** How an integrator routes broadcast for a single chain. */
export interface ProtectedRpcConfig {
  /** Protected RPC endpoint URL (e.g. Flashbots Protect). */
  rpcUrl?: string;
  /** A pre-built provider; takes precedence over {@link rpcUrl}. */
  provider?: ethers.JsonRpcProvider;
  /**
   * Custom submission for relay/bundle APIs. When present, a signed raw
   * transaction is handed here instead of being broadcast via the provider.
   * Must resolve to the resulting transaction hash.
   */
  submit?: (signedTx: string, ctx: ProtectedSubmitContext) => Promise<string>;
  /** Label for evidence/telemetry (e.g. "flashbots-protect"). */
  label?: string;
}

/**
 * Per-chain protected-RPC configuration: either a static map keyed by chain id
 * or a resolver function.
 */
export type ProtectedRpcResolver =
  | Record<number, ProtectedRpcConfig>
  | ((chain: number) => ProtectedRpcConfig | undefined);

/** Resolve the protected config for a chain, if any. */
export function resolveProtectedRpc(
  resolver: ProtectedRpcResolver | undefined,
  chain: number,
): ProtectedRpcConfig | undefined {
  if (!resolver) return undefined;
  return typeof resolver === 'function' ? resolver(chain) : resolver[chain];
}

/**
 * Build the provider to broadcast through: the integrator's protected provider
 * or RPC URL when configured, otherwise a provider over the default public RPC.
 */
export function resolveProtectedProvider(
  config: ProtectedRpcConfig | undefined,
  fallbackRpcUrl: string,
): ethers.JsonRpcProvider {
  if (config?.provider) return config.provider;
  if (config?.rpcUrl) return new ethers.JsonRpcProvider(config.rpcUrl);
  return new ethers.JsonRpcProvider(fallbackRpcUrl);
}

/** Result of a protected broadcast. `response` is present only for the RPC path. */
export interface ProtectedBroadcastResult {
  hash: string;
  response?: ethers.TransactionResponse;
}

/**
 * Broadcast a transaction through the protected route.
 *
 * - With a `submit` hook: the transaction is populated, signed locally, and the
 *   raw signed payload is handed to the integrator's relay (so it never touches
 *   the public mempool before inclusion).
 * - Otherwise: the (protected-provider-connected) signer broadcasts normally.
 *
 * The `signer` must already be connected to the provider returned by
 * {@link resolveProtectedProvider} for the non-submit path.
 */
export async function broadcastProtected(
  signer: ethers.Wallet,
  tx: ethers.TransactionRequest,
  config: ProtectedRpcConfig | undefined,
  ctx: ProtectedSubmitContext,
): Promise<ProtectedBroadcastResult> {
  if (config?.submit) {
    const populated = await signer.populateTransaction(tx);
    const signedTx = await signer.signTransaction(populated);
    const hash = await config.submit(signedTx, ctx);
    return { hash };
  }
  const response = await signer.sendTransaction(tx);
  return { hash: response.hash, response };
}
