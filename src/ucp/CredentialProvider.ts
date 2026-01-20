import { UCPProfile, UCPCheckoutRequest, UCPCheckoutResponse } from '../types/ucp';
import { StoredSession } from '../session/SessionStorage';
import { SessionKeyManager } from '../session/SessionKeyManager';

export class UCPCredentialProvider {
  constructor(private sessionManager: SessionKeyManager) {}

  getProfile(): UCPProfile {
    return {
      id: 'veridex-cp',
      name: 'Veridex Protocol Credential Provider',
      version: '2026-01-20',
      capabilities: ['checkout', 'identity_linking', 'orders'],
      transports: ['rest', 'mcp'],
      endpoints: {
        checkout: 'https://cp.veridex.network/ucp/checkout',
        identity: 'https://cp.veridex.network/ucp/identity',
        orders: 'https://cp.veridex.network/ucp/orders',
      },
    };
  }

  async tokenizePayment(session: StoredSession): Promise<string> {
    // Generate an opaque token linked to the session
    // In UCP, this is the credential passed to the business
    return Buffer.from(JSON.stringify({
      keyHash: session.keyHash,
      platformId: 'veridex-agent',
      expiresAt: session.config.expiryTimestamp,
    })).toString('base64');
  }

  async processCheckout(
    request: UCPCheckoutRequest,
    session: StoredSession
  ): Promise<UCPCheckoutResponse> {
    // 1. Validate limits
    const amount = parseFloat(request.amount);
    const limitResult = this.sessionManager.checkLimits(session, amount);
    if (!limitResult.allowed) {
      throw new Error(`Limits exceeded: ${limitResult.reason}`);
    }

    // 2. Tokenize instrument
    const token = await this.tokenizePayment(session);

    // 3. Record spending (if it's immediate)
    // Often checkout is just authorization, but for agents we might do it now
    await this.sessionManager.recordSpending(session, amount);

    return {
      checkoutId: `checkout_${Date.now()}`,
      status: 'authorized',
      paymentToken: token,
      expiresAt: Date.now() + 3600 * 1000,
    };
  }
}
