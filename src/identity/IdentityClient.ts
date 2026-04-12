/**
 * @packageDocumentation
 * @module identity/IdentityClient
 * @description
 * Client for the ERC-8004 Identity Registry (IdentityRegistryUpgradeable).
 * 
 * This is chain-agnostic for any EVM chain where ERC-8004 singletons are deployed.
 * The same contract addresses work on Base, Ethereum, Polygon, Arbitrum, Optimism,
 * Linea, MegaETH, Monad, and all their testnets.
 * 
 * Covers:
 * - Registration (mint ERC-721 agent NFT)
 * - URI management (agentURI, setAgentURI)
 * - Wallet management (agentWallet, setAgentWallet, unsetAgentWallet)
 * - Metadata (getMetadata, setMetadata)
 * - Agent resolution from endpoint domains
 * 
 * References:
 * - ADR-0029 §1.3 IdentityClient
 * - ERC8004_IMPLEMENTATION_PLAN.md Phase 1
 */
import { ethers } from 'ethers';
import {
  IDENTITY_REGISTRY_ABI,
  getERC8004Addresses,
} from './constants';
import { RegistrationFileManager } from './RegistrationFileManager';
import type {
  AgentRegistration,
  MetadataEntry,
  RegisterAgentOptions,
  ERC8004Config,
  AgentRegistrationFile,
  AgentRegistryRef,
} from './types';

// ============================================================================
// IdentityClient
// ============================================================================

export class IdentityClient {
  private provider: ethers.Provider;
  private signer?: ethers.Signer;
  private registryAddress: string;

  constructor(
    provider: ethers.Provider,
    signer?: ethers.Signer,
    config?: Partial<ERC8004Config>,
  ) {
    this.provider = provider;
    this.signer = signer;

    const addresses = getERC8004Addresses(config?.testnet ?? false);
    this.registryAddress = addresses.identityRegistry;
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  /**
   * Register a new agent on the ERC-8004 Identity Registry.
   * Mints an ERC-721 NFT representing the agent.
   * 
   * @param agentURI - URI pointing to the agent registration file (IPFS or data URI)
   * @param metadata - Optional key-value metadata entries
   * @returns The minted agentId (token ID)
   */
  async register(agentURI: string, metadata?: MetadataEntry[]): Promise<bigint> {
    this.requireSigner();
    const contract = this.getWriteContract();

    let tx: ethers.TransactionResponse;
    if (metadata && metadata.length > 0) {
      tx = await contract['register(string,tuple(string,string)[])'](agentURI, metadata);
    } else {
      tx = await contract['register(string)'](agentURI);
    }

    const receipt = await tx.wait();
    return this.extractAgentIdFromReceipt(contract, receipt!);
  }

  /**
   * Register with a full options object — builds the registration file,
   * encodes it as a data URI, and registers on-chain.
   */
  async registerWithFile(options: RegisterAgentOptions): Promise<{ agentId: bigint; agentURI: string }> {
    const regFile = RegistrationFileManager.buildRegistrationFile(options);
    const agentURI = RegistrationFileManager.buildDataURI(regFile);
    const agentId = await this.register(agentURI, options.metadata);
    return { agentId, agentURI };
  }

  // ==========================================================================
  // Read — Agent Info
  // ==========================================================================

  /**
   * Get full agent registration info.
   */
  async getAgent(agentId: bigint): Promise<AgentRegistration> {
    const contract = this.getReadContract();

    const [owner, agentURI, wallet] = await Promise.all([
      contract.ownerOf(agentId) as Promise<string>,
      this.safeCall(contract, 'agentURI', [agentId], ''),
      this.safeCall(contract, 'agentWallet', [agentId], ethers.ZeroAddress),
    ]);

    return { agentId, owner, agentURI, agentWallet: wallet };
  }

  /**
   * Get agent by owner address (returns first agent owned, or null).
   */
  async getAgentByOwner(owner: string): Promise<AgentRegistration | null> {
    const contract = this.getReadContract();
    const balance = await contract.balanceOf(owner) as bigint;
    if (balance === 0n) return null;

    // ERC-721 Enumerable would be ideal here, but ERC-8004 may not implement it.
    // Fallback: scan recent Transfer events
    try {
      const filter = contract.filters.Transfer(ethers.ZeroAddress, owner);
      const events = await contract.queryFilter(filter);
      if (events.length > 0) {
        const lastEvent = events[events.length - 1];
        const agentId = (lastEvent as any).args?.tokenId;
        if (agentId !== undefined) {
          return this.getAgent(agentId);
        }
      }
    } catch {
      // Event querying may not be supported on all providers
    }

    return null;
  }

  /**
   * Get the agentURI for an agent.
   */
  async getAgentURI(agentId: bigint): Promise<string> {
    const contract = this.getReadContract();
    // Try agentURI first (ERC-8004 specific), fall back to tokenURI (ERC-721)
    return this.safeCall(contract, 'agentURI', [agentId], '') ||
           this.safeCall(contract, 'tokenURI', [agentId], '');
  }

  /**
   * Get the agentWallet address for an agent.
   * This maps to the session key address in the Veridex USKS model.
   */
  async getAgentWallet(agentId: bigint): Promise<string> {
    const contract = this.getReadContract();
    return this.safeCall(contract, 'agentWallet', [agentId], ethers.ZeroAddress);
  }

  /**
   * Get a metadata value by key.
   */
  async getMetadata(agentId: bigint, key: string): Promise<string> {
    const contract = this.getReadContract();
    return this.safeCall(contract, 'getMetadata', [agentId, key], '');
  }

  /**
   * Get the owner of an agent NFT.
   */
  async getOwner(agentId: bigint): Promise<string> {
    const contract = this.getReadContract();
    return contract.ownerOf(agentId) as Promise<string>;
  }

  /**
   * Get how many agents an address owns.
   */
  async getBalance(owner: string): Promise<bigint> {
    const contract = this.getReadContract();
    return contract.balanceOf(owner) as Promise<bigint>;
  }

  /**
   * Get total number of registered agents.
   */
  async getTotalSupply(): Promise<bigint> {
    const contract = this.getReadContract();
    return contract.totalSupply() as Promise<bigint>;
  }

  // ==========================================================================
  // Write — URI and Wallet Management
  // ==========================================================================

  /**
   * Update the agentURI (registration file pointer).
   */
  async setAgentURI(agentId: bigint, newURI: string): Promise<ethers.TransactionResponse> {
    this.requireSigner();
    const contract = this.getWriteContract();
    return contract.setAgentURI(agentId, newURI);
  }

  /**
   * Set the agentWallet address (session key address).
   * Requires an EIP-712 signature proving control of the wallet address.
   * 
   * In the Veridex USKS model:
   * - Human passkey owner calls this after generating a session key
   * - The session key address becomes the agentWallet
   * - This links the on-chain identity to the authorized session key
   */
  async setAgentWallet(
    agentId: bigint,
    wallet: string,
    deadline: number,
    signature: string,
  ): Promise<ethers.TransactionResponse> {
    this.requireSigner();
    const contract = this.getWriteContract();
    return contract.setAgentWallet(agentId, wallet, deadline, signature);
  }

  /**
   * Unset the agentWallet (revoke session key linkage).
   * Called when the session key is revoked.
   */
  async unsetAgentWallet(agentId: bigint): Promise<ethers.TransactionResponse> {
    this.requireSigner();
    const contract = this.getWriteContract();
    return contract.unsetAgentWallet(agentId);
  }

  /**
   * Set a metadata key-value pair.
   */
  async setMetadata(agentId: bigint, key: string, value: string): Promise<ethers.TransactionResponse> {
    this.requireSigner();
    const contract = this.getWriteContract();
    return contract.setMetadata(agentId, key, value);
  }

  // ==========================================================================
  // Resolution
  // ==========================================================================

  /**
   * Build a CAIP-2 agent registry identifier for this chain.
   * Format: eip155:{chainId}:{registryAddress}
   */
  async buildAgentRegistryId(): Promise<string> {
    const network = await this.provider.getNetwork();
    return `eip155:${network.chainId}:${this.registryAddress}`;
  }

  /**
   * Resolve an agent from a service endpoint domain.
   * Checks /.well-known/agent-registration.json
   */
  async resolveAgentFromEndpoint(endpoint: string): Promise<AgentRegistration | null> {
    try {
      const domain = new URL(endpoint).hostname;
      const res = await fetch(`https://${domain}/.well-known/agent-registration.json`);
      if (!res.ok) return null;

      const wellKnown = await res.json() as { agentId?: number };
      if (!wellKnown.agentId) return null;

      return this.getAgent(BigInt(wellKnown.agentId));
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Static Helpers — Registration File (delegates to RegistrationFileManager)
  // ==========================================================================

  /** @deprecated Use RegistrationFileManager.buildRegistrationFile() directly */
  static buildRegistrationFile(options: RegisterAgentOptions): AgentRegistrationFile {
    return RegistrationFileManager.buildRegistrationFile(options);
  }

  /** @deprecated Use RegistrationFileManager.buildDataURI() directly */
  static buildDataURI(file: AgentRegistrationFile): string {
    return RegistrationFileManager.buildDataURI(file);
  }

  /** @deprecated Use RegistrationFileManager.addRegistration() directly */
  static addRegistration(file: AgentRegistrationFile, ref: AgentRegistryRef): AgentRegistrationFile {
    return RegistrationFileManager.addRegistration(file, ref);
  }

  /** @deprecated Use RegistrationFileManager.addService() directly */
  static addService(file: AgentRegistrationFile, service: { name: string; endpoint: string; version?: string }): AgentRegistrationFile {
    return RegistrationFileManager.addService(file, service);
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getRegistryAddress(): string {
    return this.registryAddress;
  }

  getProvider(): ethers.Provider {
    return this.provider;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private getReadContract(): ethers.Contract {
    return new ethers.Contract(this.registryAddress, IDENTITY_REGISTRY_ABI, this.provider);
  }

  private getWriteContract(): ethers.Contract {
    return new ethers.Contract(this.registryAddress, IDENTITY_REGISTRY_ABI, this.signer);
  }

  private requireSigner(): void {
    if (!this.signer) {
      throw new Error('IdentityClient: signer required for write operations.');
    }
  }

  private async extractAgentIdFromReceipt(
    contract: ethers.Contract,
    receipt: ethers.TransactionReceipt,
  ): Promise<bigint> {
    // Try to extract from Transfer event
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed?.name === 'Transfer') {
          return parsed.args.tokenId;
        }
      } catch {
        continue;
      }
    }

    // Fallback: read totalSupply
    const totalSupply = await contract.totalSupply();
    return totalSupply;
  }

  /**
   * Safely call a contract method, returning a default value on failure.
   * Useful for methods that may not exist on older registry deployments.
   */
  private async safeCall(
    contract: ethers.Contract,
    method: string,
    args: any[],
    defaultValue: any,
  ): Promise<any> {
    try {
      return await contract[method](...args);
    } catch {
      return defaultValue;
    }
  }
}
