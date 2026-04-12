/**
 * @packageDocumentation
 * @module CapabilityNegotiator
 * @description
 * Implements the UCP Capability Discovery protocol.
 * 
 * Agents and Merchants need to fetch a common set of features (e.g., supported payment methods,
 * identity linking requirements, delivery options) before a transaction can occur.
 * 
 * This class handles:
 * - Advertising supported capabilities (checkout, identity, orders).
 * - Negotiating the intersection of Agent/Merchant capabilities.
 */
export interface NegotiationResult {
  agreed: string[];
  rejected: string[];
}

export class CapabilityNegotiator {
  private supportedCapabilities = ['checkout', 'identity_linking', 'orders'];

  /**
   * Negotiate capabilities (async version for compatibility).
   */
  async negotiateCapabilities(requested: string[]): Promise<string[]> {
    return this.negotiate(requested).agreed;
  }

  /**
   * Synchronous capability negotiation.
   */
  negotiate(requested: string[]): NegotiationResult {
    const agreed = requested.filter(cap => this.supportedCapabilities.includes(cap));
    const rejected = requested.filter(cap => !this.supportedCapabilities.includes(cap));
    return { agreed, rejected };
  }

  /**
   * Get all supported capabilities.
   */
  getSupportedCapabilities(): string[] {
    return [...this.supportedCapabilities];
  }
}
