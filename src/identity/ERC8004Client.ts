/**
 * @packageDocumentation
 * @module ERC8004Client
 * @description
 * Unified facade for ERC-8004 Identity, Reputation, and Veridex ServiceDirectory.
 * 
 * This class composes the separate IdentityClient, ReputationClient, and
 * ServiceDirectoryClient into a single convenience API. It maintains backward
 * compatibility with the original monolithic interface while delegating to
 * the properly separated clients underneath.
 * 
 * **For new code, prefer using the individual clients directly:**
 * - `IdentityClient` — ERC-8004 Identity Registry (chain-agnostic)
 * - `ReputationClient` — ERC-8004 Reputation Registry (chain-agnostic)
 * - `ServiceDirectoryClient` — Veridex ServiceDirectory (Veridex-specific)
 * - `TrustGate` — Pre-payment reputation checks
 * - `AgentDiscovery` — Agent search and resolution
 * 
 * This facade exists for backward compatibility and as a quick-start API.
 * 
 * References:
 * - ADR-0029: ERC-8004 Trustless Agent Identity and Reputation
 * - ERC8004_IMPLEMENTATION_PLAN.md
 * - UATL paper: Universal Agent Trust Layer
 */
import { ethers } from 'ethers';
import { IdentityClient } from './IdentityClient';
import { ReputationClient } from './ReputationClient';
import { ServiceDirectoryClient } from './ServiceDirectoryClient';
import {
  getERC8004Addresses,
  ERC8004_TESTNET_IDENTITY,
  ERC8004_TESTNET_REPUTATION,
  ERC8004_MAINNET_IDENTITY,
  ERC8004_MAINNET_REPUTATION,
} from './constants';
import type {
  AgentRegistration,
  FeedbackSummary,
  FeedbackOptions,
  ServiceRegistration,
  ServiceInfo,
  ERC8004Config,
  RegisterAgentOptions,
  AgentRegistrationFile,
} from './types';

// Re-export canonical addresses for backward compatibility
export const ERC8004_IDENTITY_REGISTRY = ERC8004_TESTNET_IDENTITY;
export const ERC8004_REPUTATION_REGISTRY = ERC8004_TESTNET_REPUTATION;

// ============================================================================
// Legacy Types (re-exported from types.ts for backward compatibility)
// ============================================================================

/** @deprecated Use AgentRegistration from './types' instead */
export interface AgentIdentity {
  agentId: bigint;
  owner: string;
  tokenURI: string;
}

/** Agent metadata for registration (Veridex-extended format) */
export interface AgentMetadata {
  name: string;
  description: string;
  category: string;
  version: string;
  endpointUrl?: string;
  image?: string;
  capabilities?: string[];
}

/** @deprecated Use FeedbackSummary + normalized score from ReputationClient */
export interface ReputationSummary {
  agentId: bigint;
  feedbackCount: bigint;
  summaryValue: bigint;
  summaryValueDecimals: number;
  normalizedScore: number;
}

/** @deprecated Use FeedbackOptions from './types' instead */
export interface FeedbackParams {
  agentId: bigint;
  value: number;
  valueDecimals?: number;
  tag1?: string;
  tag2?: string;
}

// Re-export types that consumers may already import from here
export type { ServiceRegistration, ServiceInfo } from './types';

export interface ERC8004ClientConfig {
  rpcUrl: string;
  /** Whether to use testnet addresses (default: true for backward compat) */
  testnet?: boolean;
  identityRegistryAddress?: string;
  reputationRegistryAddress?: string;
  serviceDirectoryAddress?: string;
  signer?: ethers.Wallet;
}

// ============================================================================
// ERC8004Client — Unified Facade
// ============================================================================

export class ERC8004Client {
  private provider: ethers.JsonRpcProvider;
  private signer?: ethers.Wallet;

  /** Underlying IdentityClient (ERC-8004 standard) */
  public readonly identity: IdentityClient;
  /** Underlying ReputationClient (ERC-8004 standard) */
  public readonly reputation: ReputationClient;
  /** Underlying ServiceDirectoryClient (Veridex-specific), null if not configured */
  public readonly serviceDirectory: ServiceDirectoryClient | null;

  // Addresses stored for backward-compat getters
  private identityAddress: string;
  private reputationAddress: string;
  private serviceDirectoryAddress: string;

  constructor(config: ERC8004ClientConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    const testnet = config.testnet ?? true;
    const addresses = getERC8004Addresses(testnet);

    this.identityAddress = config.identityRegistryAddress || addresses.identityRegistry;
    this.reputationAddress = config.reputationRegistryAddress || addresses.reputationRegistry;
    this.serviceDirectoryAddress = config.serviceDirectoryAddress || '';

    if (config.signer) {
      this.signer = config.signer.connect(this.provider);
    }

    // Create underlying clients
    const erc8004Config: Partial<ERC8004Config> = { testnet };

    this.identity = new IdentityClient(this.provider, this.signer, erc8004Config);
    this.reputation = new ReputationClient(this.provider, this.signer, erc8004Config);
    this.serviceDirectory = this.serviceDirectoryAddress
      ? new ServiceDirectoryClient(this.provider, this.serviceDirectoryAddress, this.signer)
      : null;
  }

  /**
   * Set or update the signer (e.g., when session key is received from human).
   */
  setSigner(signer: ethers.Wallet): void {
    this.signer = signer.connect(this.provider);
    // Note: underlying clients are immutable; create new facade if signer changes
    // For full signer rotation, construct a new ERC8004Client
  }

  // ==========================================================================
  // Identity Registry — Write Operations
  // ==========================================================================

  /**
   * Register a new agent identity on ERC-8004.
   * Mints an ERC-721 NFT representing the agent.
   * 
   * @param metadata - Agent metadata to store as tokenURI (JSON)
   * @returns The minted agent ID (token ID)
   */
  async registerAgent(metadata: AgentMetadata): Promise<bigint> {
    // Build registration file from legacy metadata format
    const regFile = IdentityClient.buildRegistrationFile({
      name: metadata.name,
      description: metadata.description,
      image: metadata.image,
      services: metadata.endpointUrl
        ? [{ name: 'web', endpoint: metadata.endpointUrl }]
        : [],
      x402Support: true,
      supportedTrust: ['reputation'],
    });

    const agentURI = IdentityClient.buildDataURI(regFile);
    return this.identity.register(agentURI);
  }

  // ==========================================================================
  // Identity Registry — Read Operations
  // ==========================================================================

  /**
   * Get agent identity info by token ID.
   */
  async getAgent(agentId: bigint): Promise<AgentIdentity> {
    const reg = await this.identity.getAgent(agentId);
    return {
      agentId: reg.agentId,
      owner: reg.owner,
      tokenURI: reg.agentURI,
    };
  }

  async getAgentOwner(agentId: bigint): Promise<string> {
    return this.identity.getOwner(agentId);
  }

  async getAgentCount(owner: string): Promise<bigint> {
    return this.identity.getBalance(owner);
  }

  async getTotalAgents(): Promise<bigint> {
    return this.identity.getTotalSupply();
  }

  // ==========================================================================
  // Reputation Registry — Write Operations
  // ==========================================================================

  async giveFeedback(params: FeedbackParams): Promise<ethers.TransactionReceipt> {
    const tx = await this.reputation.giveFeedback(params.agentId, {
      value: params.value,
      valueDecimals: params.valueDecimals,
      tag1: params.tag1,
      tag2: params.tag2,
    });
    return tx.wait() as Promise<ethers.TransactionReceipt>;
  }

  // ==========================================================================
  // Reputation Registry — Read Operations
  // ==========================================================================

  async getReputation(agentId: bigint, tag1 = '', tag2 = ''): Promise<ReputationSummary> {
    const summary = await this.reputation.getSummary(agentId, [], tag1, tag2);

    const normalizedScore = summary.summaryValueDecimals > 0
      ? Number(summary.summaryValue) / (10 ** summary.summaryValueDecimals)
      : Number(summary.summaryValue);

    return {
      agentId,
      feedbackCount: summary.count,
      summaryValue: summary.summaryValue,
      summaryValueDecimals: summary.summaryValueDecimals,
      normalizedScore,
    };
  }

  async getAgentClients(agentId: bigint): Promise<string[]> {
    return this.reputation.getClients(agentId);
  }

  // ==========================================================================
  // Service Directory — Write Operations (delegates to ServiceDirectoryClient)
  // ==========================================================================

  async registerService(params: ServiceRegistration): Promise<ethers.TransactionReceipt> {
    this.requireServiceDirectory();
    return this.serviceDirectory!.registerService(params);
  }

  async deactivateService(agentId: bigint, serviceIndex: bigint): Promise<ethers.TransactionReceipt> {
    this.requireServiceDirectory();
    return this.serviceDirectory!.deactivateService(agentId, serviceIndex);
  }

  async activateService(agentId: bigint, serviceIndex: bigint): Promise<ethers.TransactionReceipt> {
    this.requireServiceDirectory();
    return this.serviceDirectory!.activateService(agentId, serviceIndex);
  }

  async updateService(
    agentId: bigint,
    serviceIndex: bigint,
    params: Partial<Pick<ServiceRegistration, 'endpointUrl' | 'description' | 'pricePerCall' | 'paymentToken'>>,
  ): Promise<ethers.TransactionReceipt> {
    this.requireServiceDirectory();
    return this.serviceDirectory!.updateService(agentId, serviceIndex, params);
  }

  // ==========================================================================
  // Service Directory — Read Operations
  // ==========================================================================

  async discoverServices(category: string): Promise<ServiceInfo[]> {
    this.requireServiceDirectory();
    return this.serviceDirectory!.discoverServices(category);
  }

  async getActiveServices(): Promise<ServiceInfo[]> {
    this.requireServiceDirectory();
    return this.serviceDirectory!.getActiveServices();
  }

  async getServicesByAgent(agentId: bigint): Promise<ServiceInfo[]> {
    this.requireServiceDirectory();
    return this.serviceDirectory!.getServicesByAgent(agentId);
  }

  async getService(serviceId: bigint): Promise<ServiceInfo> {
    this.requireServiceDirectory();
    return this.serviceDirectory!.getService(serviceId);
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  getIdentityAddress(): string {
    return this.identityAddress;
  }

  getReputationAddress(): string {
    return this.reputationAddress;
  }

  getServiceDirectoryAddress(): string {
    return this.serviceDirectoryAddress;
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  private requireServiceDirectory(): void {
    if (!this.serviceDirectory) {
      throw new Error('ERC8004Client: serviceDirectoryAddress not configured.');
    }
  }
}
