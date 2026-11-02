/**
 * Example: Nano (XNO) feeless x402 settlement rail
 *
 * Nano is a feeless, sub-second, serverless payment rail with no smart contracts
 * and no custody layer — a payment is proven by the block existing on the Nano
 * ledger. This example shows a merchant (paywall) and a payer settling a Nano
 * x402 payment through the NanoFacilitatorAdapter, which verifies settlement
 * by reading the Nano node directly.
 *
 * Run with `npx tsx examples/nano-x402.ts` (or `bun run examples/nano-x402.ts`).
 * No funds move here: it demonstrates the adapter's shape and offline flows.
 */
import {
  NanoFacilitatorAdapter,
  buildNanoPaymentRequirements,
  xnoToRaw,
} from '../src/x402/adapters/NanoFacilitatorAdapter';

async function main() {
  // The merchant (resource server) sets the price and its Nano address.
  const recipient = 'nano_1yourownaddress0000000000000000000000000000000000000000000000000';
  const priceXNO = '0.001';

  console.log('== Paywall: the merchant offers a paid endpoint ==');

  const nano = new NanoFacilitatorAdapter({ network: 'nano:mainnet' });

  // Issue one order: an opaque id plus an exact, tagged amount and an expiry window.
  const order = await nano.issueOrder({ recipient, priceXNO });

  // Build the PAYMENT-REQUIRED requirements (the `nano:mainnet` leg) for that order.
  const req = buildNanoPaymentRequirements({ priceXNO, recipientAddress: recipient, order, description: 'One LLM completion' });
  console.log('Payment requirement:', JSON.stringify(req, null, 2));
  console.log('Raw amount incl. the per-order tag:', req.maxAmountRequired);
  console.log('Price in raw (no tag):', xnoToRaw(priceXNO));
  console.log('\nAdapter capabilities:', nano.getCapabilities());

  console.log('\n== The payer pays (block lands on the Nano ledger) ==');
  console.log('For feeless Nano there is no facilitator round-trip and no batching:');
  console.log('the payer submits a signed state block straight to the network.');
  console.log('The orderId and the block hash are carried in the x402 payment payload.');

  // On the merchant side, verifying and settling are the same on-ledger fact:
  // is the block a confirmed send of THIS order's exact amount to *our* address, inside its window, and not claimed before?
  console.log('\n== Merchant: verify + settle via the adapter ==');
  console.log('A payload for block HASH123... pays', priceXNO, 'XNO to', recipient);
  console.log('Settlement is on-ledger and feeless — no custodial facilitator,');
  console.log('no off-chain batching risk.');

  console.log('\nNext step for a live integration: call nano.verify(req, response)');
  console.log('with the real block hash; if true, call nano.settle(...) to emit');
  console.log('a PaymentSettlementResponse for your audit log.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
