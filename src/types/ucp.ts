/**
 * @packageDocumentation
 * @module UCPTypes
 * @description
 * Type definitions for the Universal Commerce Protocol (UCP).
 * 
 * Includes interfaces for:
 * - {@link UCPProfile}: Identity and capabilities of a UCP actor.
 * - {@link UCPCheckoutRequest}: Structure of a checkout payload.
 */
export interface UCPProfile {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  transports: string[];
  endpoints: {
    checkout: string;
    identity: string;
    orders: string;
  };
}

export interface UCPLineItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: string;
  currency: string;
}

export interface UCPCheckoutRequest {
  platformId: string;
  businessId: string;
  amount: string;
  currency: string;
  items: UCPLineItem[];
  metadata?: Record<string, any>;
}

export interface UCPCheckoutResponse {
  checkoutId: string;
  status: 'pending' | 'authorized' | 'completed' | 'failed';
  paymentToken: string;
  transactionHash?: string;
  expiresAt: number;
}
