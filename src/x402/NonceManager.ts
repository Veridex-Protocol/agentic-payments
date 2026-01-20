import { ethers } from 'ethers';

export class NonceManager {
  private nonces: Map<string, string[]> = new Map();

  getNextNonce(keyHash: string): string {
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const used = this.nonces.get(keyHash) || [];
    used.push(nonce);
    this.nonces.set(keyHash, used);
    return nonce;
  }

  isUsed(keyHash: string, nonce: string): boolean {
    return (this.nonces.get(keyHash) || []).includes(nonce);
  }
}
