/**
 * @packageDocumentation
 * @module identity/ServiceDirectoryClient
 * @description
 * Client for the VeridexServiceDirectory contract.
 * 
 * **This is NOT part of the ERC-8004 standard.** It is a Veridex-specific
 * on-chain agent marketplace contract deployed on Monad and other chains.
 * 
 * Separated from the ERC-8004 clients to maintain clean boundaries between
 * the standard (Identity + Reputation + Validation registries) and
 * Veridex-specific infrastructure.
 */
import { ethers } from 'ethers';
import { SERVICE_DIRECTORY_ABI, VERIDEX_SERVICE_DIRECTORY } from './constants';
import type { ServiceRegistration, ServiceInfo } from './types';

// ============================================================================
// ServiceDirectoryClient
// ============================================================================

export class ServiceDirectoryClient {
  private provider: ethers.Provider;
  private signer?: ethers.Signer;
  private directoryAddress: string;

  constructor(
    provider: ethers.Provider,
    directoryAddress: string,
    signer?: ethers.Signer,
  ) {
    this.provider = provider;
    this.directoryAddress = directoryAddress;
    this.signer = signer;
  }

  /**
   * Create a ServiceDirectoryClient for a known chain.
   */
  static forChain(
    provider: ethers.Provider,
    chain: string,
    signer?: ethers.Signer,
  ): ServiceDirectoryClient | null {
    const address = VERIDEX_SERVICE_DIRECTORY[chain];
    if (!address) return null;
    return new ServiceDirectoryClient(provider, address, signer);
  }

  // ==========================================================================
  // Write
  // ==========================================================================

  async registerService(params: ServiceRegistration): Promise<ethers.TransactionReceipt> {
    this.requireSigner();
    const contract = this.getWriteContract();

    const tx = await contract.registerService(
      params.agentId,
      params.endpointUrl,
      params.category,
      params.description,
      params.pricePerCall,
      params.paymentToken,
    );
    return tx.wait();
  }

  async deactivateService(agentId: bigint, serviceIndex: bigint): Promise<ethers.TransactionReceipt> {
    this.requireSigner();
    const contract = this.getWriteContract();
    const tx = await contract.deactivateService(agentId, serviceIndex);
    return tx.wait();
  }

  async activateService(agentId: bigint, serviceIndex: bigint): Promise<ethers.TransactionReceipt> {
    this.requireSigner();
    const contract = this.getWriteContract();
    const tx = await contract.activateService(agentId, serviceIndex);
    return tx.wait();
  }

  async updateService(
    agentId: bigint,
    serviceIndex: bigint,
    params: Partial<Pick<ServiceRegistration, 'endpointUrl' | 'description' | 'pricePerCall' | 'paymentToken'>>,
  ): Promise<ethers.TransactionReceipt> {
    this.requireSigner();

    const current = await this.getServicesByAgent(agentId);
    const svc = current[Number(serviceIndex)];
    if (!svc) throw new Error(`Service index ${serviceIndex} not found for agent ${agentId}`);

    const contract = this.getWriteContract();
    const tx = await contract.updateService(
      agentId,
      serviceIndex,
      params.endpointUrl ?? svc.endpointUrl,
      params.description ?? svc.description,
      params.pricePerCall ?? svc.pricePerCall,
      params.paymentToken ?? svc.paymentToken,
    );
    return tx.wait();
  }

  // ==========================================================================
  // Read
  // ==========================================================================

  async discoverServices(category: string): Promise<ServiceInfo[]> {
    const contract = this.getReadContract();
    const raw = await contract.getServicesByCategory(category);
    return raw.map(ServiceDirectoryClient.parseService);
  }

  async getActiveServices(): Promise<ServiceInfo[]> {
    const contract = this.getReadContract();
    const raw = await contract.getActiveServices();
    return raw.map(ServiceDirectoryClient.parseService);
  }

  async getServicesByAgent(agentId: bigint): Promise<ServiceInfo[]> {
    const contract = this.getReadContract();
    const raw = await contract.getServicesByAgent(agentId);
    return raw.map(ServiceDirectoryClient.parseService);
  }

  async getService(serviceId: bigint): Promise<ServiceInfo> {
    const contract = this.getReadContract();
    const raw = await contract.getService(serviceId);
    return ServiceDirectoryClient.parseService(raw);
  }

  async getTotalServices(): Promise<bigint> {
    const contract = this.getReadContract();
    return contract.totalServices();
  }

  async getTotalCategories(): Promise<bigint> {
    const contract = this.getReadContract();
    return contract.totalCategories();
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getDirectoryAddress(): string {
    return this.directoryAddress;
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  private getReadContract(): ethers.Contract {
    return new ethers.Contract(this.directoryAddress, SERVICE_DIRECTORY_ABI, this.provider);
  }

  private getWriteContract(): ethers.Contract {
    return new ethers.Contract(this.directoryAddress, SERVICE_DIRECTORY_ABI, this.signer);
  }

  private requireSigner(): void {
    if (!this.signer) {
      throw new Error('ServiceDirectoryClient: signer required for write operations.');
    }
  }

  private static parseService(raw: any): ServiceInfo {
    return {
      serviceId: BigInt(raw.serviceId),
      agentId: BigInt(raw.agentId),
      agent: raw.agent,
      endpointUrl: raw.endpointUrl,
      category: raw.category,
      description: raw.description,
      pricePerCall: BigInt(raw.pricePerCall),
      paymentToken: raw.paymentToken,
      active: raw.active,
      registeredAt: BigInt(raw.registeredAt),
    };
  }
}
