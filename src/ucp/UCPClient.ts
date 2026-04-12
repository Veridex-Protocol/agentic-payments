/**
 * @packageDocumentation
 * @module UCPClient
 * @description
 * Client implementation for Universal Commerce Protocol (UCP) interactions.
 * 
 * Handles the flow of:
 * 1. Discovering UCP capabilities from a 402 or standard checkout URL.
 * 2. Creating a checkout session.
 * 3. Selecting a compatible payment handler (e.g. Veridex Passkey Payment).
 * 4. Generating the required cryptographic payment credentials.
 * 5. Completing the checkout.
 */
import { ethers } from 'ethers';
import { StoredSession } from '../session/SessionStorage';
import { VeridexSDK } from '@veridex/sdk';
import axios from 'axios';

// Interfaces for UCP interaction
// These should ideally come from @ucp-js/sdk if available, but defining here for now
interface UCPHandler {
    id: string;
    name: string;
    version: string;
    config: Record<string, any>;
}

interface UCPCheckoutResponse {
    checkout_id: string;
    handlers: UCPHandler[];
    total: {
        amount: string;
        currency: string;
    };
}

export class UCPClient {
    constructor(private coreSDK: VeridexSDK) { }

    /**
     * Initiates the UCP flow starting from a checkout URL found in a 402 response.
     */
    async initiateCheckoutFlow(
        checkoutUrl: string,
        session: StoredSession,
        originalRequestOptions: RequestInit
    ): Promise<any> { // Returns the credential to include in the retry

        // 1. Create Checkout
        const checkoutResponse = await this.createCheckout(checkoutUrl);

        // 2. Find Veridex Handler
        const handler = checkoutResponse.handlers.find(h => h.name === 'dev.veridex.passkey_payment');

        if (!handler) {
            throw new Error('No supported payment handler found in UCP response. Expected dev.veridex.passkey_payment');
        }

        // 3. Extract Payment Details from Handler Config
        const { recipient_address, chain_id, token_address, amount } = handler.config;
        // Note: Amount might be in total.amount or handler config depending on implementation.
        // Using handler config as per PRD Task 5.3 example.

        // 4. Sign Payment (Credential Creation)
        const credential = await this.createVeridexCredential(
            session,
            recipient_address,
            chain_id,
            token_address,
            amount || checkoutResponse.total.amount // Fallback to total
        );

        // 5. Complete Checkout
        const completeUrl = `${checkoutUrl}/${checkoutResponse.checkout_id}/complete`; // Standard UCP pattern? Or provided in response links?
        // PRD says "Call the complete_checkout endpoint...". Usually REST APIs provides links.
        // Assuming standard appended path for now or passed in options.

        // Better: checkoutUrl might trigger the creation, response has the ID.
        // Let's assume the checkout URL *is* the endpoint to POST to create.
        // Then we need to know where to complete.
        // For simplicity, I'll assume we POST to `checkoutUrl/complete` with the checkout_id param or similar.
        // Actually PRD Step 9: "Call the UCP complete_checkout endpoint..."

        return await this.completeCheckout(completeUrl, credential);
    }

    private async createCheckout(url: string): Promise<UCPCheckoutResponse> {
        // Initiate checkout negotiation
        // In a real UCP flow, we might send our supported capabilities here.
        const response = await axios.post(url, {
            consumer_platform: 'veridex-agent',
            supported_handlers: ['dev.veridex.passkey_payment']
        });

        return response.data;
    }

    private async createVeridexCredential(
        session: StoredSession,
        recipient: string,
        chainId: number,
        token: string,
        amount: string
    ): Promise<string> {
        // This mocks the signing process using the session key
        // We used ethers.Wallet in PaymentSigner.ts.

        const wallet = new ethers.Wallet(session.encryptedPrivateKey); // Decryption assumed handled or handled here

        // Payload for Veridex Relayer execution
        // Similar to PaymentSigner but specifically for the Veridex Handler Payload
        const payload = {
            recipient,
            chain_id: chainId,
            token,
            amount,
            nonce: Date.now(), // Simple nonce
            timestamp: Date.now()
        };

        // Sign the payload
        // In reality this should match the Relayer's expected typed data format
        const signature = await wallet.signMessage(JSON.stringify(payload));

        return JSON.stringify({
            payload,
            signature,
            signer: wallet.address,
            key_hash: session.keyHash
        });
    }

    private async completeCheckout(url: string, credential: string): Promise<any> {
        const response = await axios.post(url, {
            payment_credential: {
                handler: 'dev.veridex.passkey_payment',
                data: credential
            }
        });

        return response.data;
    }
}
