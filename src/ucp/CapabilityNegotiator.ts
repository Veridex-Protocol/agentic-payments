export class CapabilityNegotiator {
  private supportedCapabilities = ['checkout', 'identity_linking', 'orders'];

  async negotiateCapabilities(requested: string[]): Promise<string[]> {
    // Return the intersection of requested and supported
    return requested.filter(cap => this.supportedCapabilities.includes(cap));
  }
}
