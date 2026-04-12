/**
 * @packageDocumentation
 * @module AgentRegistrar
 * @description
 * Orchestrates the full agent registration flow:
 * 
 * 1. Human creates passkey wallet (WebAuthn P-256)
 * 2. Human configures budget and generates session key
 * 3. Agent receives session key from human
 * 4. Agent mints ERC-8004 identity NFT on Monad
 * 5. Agent registers service on VeridexServiceDirectory
 * 6. Agent connects to Veridex Gateway (dashboard monitoring)
 * 7. Agent chooses visibility: public or private (invite code)
 * 
 * This class is the single entry point for agent developers using @veridex/agent-sdk.
 */
import { ethers } from 'ethers';
import {
  ERC8004Client,
  type AgentMetadata,
  type ServiceRegistration,
  type ERC8004ClientConfig,
} from './ERC8004Client';

// ============================================================================
// Types
// ============================================================================

export interface AgentRegistrarConfig {
  /** Monad RPC URL */
  rpcUrl: string;
  /** Session key private key (hex string, received from human owner) */
  sessionKeyPrivateKey: string;
  /** ServiceDirectory contract address */
  serviceDirectoryAddress: string;
  /** Optional: Identity Registry address (defaults to canonical) */
  identityRegistryAddress?: string;
  /** Optional: Reputation Registry address (defaults to canonical) */
  reputationRegistryAddress?: string;
  /** Optional: Gateway URL for dashboard monitoring */
  gatewayUrl?: string;
}

export interface RegistrationResult {
  agentId: bigint;
  ownerAddress: string;
  sessionKeyAddress: string;
  tokenURI: string;
  serviceId?: bigint;
  gatewayId?: string;
  inviteCode?: string;
}

export type AgentVisibility = 'public' | 'private';

export interface AgentProfile {
  agentId: bigint;
  metadata: AgentMetadata;
  visibility: AgentVisibility;
  inviteCode: string | null;
  services: ServiceRegistration[];
  ownerAddress: string;
  sessionKeyAddress: string;
}

// ============================================================================
// AgentRegistrar
// ============================================================================

export class AgentRegistrar {
  private erc8004: ERC8004Client;
  private signer: ethers.Wallet;
  private gatewayUrl: string;
  private agentId: bigint | null = null;
  private visibility: AgentVisibility = 'public';
  private inviteCode: string | null = null;
  private gatewayId: string | null = null;

  constructor(config: AgentRegistrarConfig) {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(config.sessionKeyPrivateKey, provider);
    this.gatewayUrl = config.gatewayUrl || process.env.VERIDEX_GATEWAY_URL || 'http://localhost:3100';

    this.erc8004 = new ERC8004Client({
      rpcUrl: config.rpcUrl,
      identityRegistryAddress: config.identityRegistryAddress,
      reputationRegistryAddress: config.reputationRegistryAddress,
      serviceDirectoryAddress: config.serviceDirectoryAddress,
      signer: this.signer,
    });
  }

  // ==========================================================================
  // Full Registration Flow
  // ==========================================================================

  /**
   * Execute the full agent registration flow:
   * 1. Mint ERC-8004 identity
   * 2. Register service on ServiceDirectory
   * 3. Connect to gateway
   * 4. Set visibility
   * 
   * @param metadata - Agent metadata (name, description, category, etc.)
   * @param service - Service registration params (endpoint, price, etc.)
   * @param visibility - 'public' or 'private'
   * @returns Registration result with agentId, serviceId, gatewayId, inviteCode
   */
  async register(
    metadata: AgentMetadata,
    service?: Omit<ServiceRegistration, 'agentId'>,
    visibility: AgentVisibility = 'public',
  ): Promise<RegistrationResult> {
    console.log(`[AgentRegistrar] Starting registration for "${metadata.name}"...`);

    // Step 1: Mint ERC-8004 identity
    console.log('[AgentRegistrar] Step 1/4: Minting ERC-8004 identity...');
    const agentId = await this.erc8004.registerAgent(metadata);
    this.agentId = agentId;
    console.log(`[AgentRegistrar] Identity minted: ERC-8004 #${agentId}`);

    // Step 2: Register service (optional)
    let serviceId: bigint | undefined;
    if (service) {
      console.log('[AgentRegistrar] Step 2/4: Registering service on ServiceDirectory...');
      try {
        await this.erc8004.registerService({
          ...service,
          agentId,
        });
        const services = await this.erc8004.getServicesByAgent(agentId);
        serviceId = services.length > 0 ? services[services.length - 1].serviceId : undefined;
        console.log(`[AgentRegistrar] Service registered: #${serviceId}`);
      } catch (error: any) {
        console.warn(`[AgentRegistrar] Service registration failed (non-blocking): ${error.message}`);
      }
    } else {
      console.log('[AgentRegistrar] Step 2/4: Skipped (no service params)');
    }

    // Step 3: Connect to gateway
    console.log('[AgentRegistrar] Step 3/4: Connecting to gateway...');
    const gatewayId = await this.connectToGateway(metadata);
    this.gatewayId = gatewayId;

    // Step 4: Set visibility
    console.log(`[AgentRegistrar] Step 4/4: Setting visibility to "${visibility}"...`);
    this.setVisibility(visibility);

    const result: RegistrationResult = {
      agentId,
      ownerAddress: this.signer.address,
      sessionKeyAddress: this.signer.address,
      tokenURI: this.buildTokenURI(metadata),
      serviceId,
      gatewayId: gatewayId || undefined,
      inviteCode: this.inviteCode || undefined,
    };

    console.log(`[AgentRegistrar] Registration complete!`);
    console.log(`  Agent ID:    ERC-8004 #${agentId}`);
    console.log(`  Owner:       ${this.signer.address}`);
    console.log(`  Gateway ID:  ${gatewayId || 'not connected'}`);
    console.log(`  Visibility:  ${visibility}`);
    if (this.inviteCode) {
      console.log(`  Invite Code: ${this.inviteCode}`);
    }

    return result;
  }

  // ==========================================================================
  // Individual Steps (for granular control)
  // ==========================================================================

  /**
   * Mint ERC-8004 identity only.
   */
  async mintIdentity(metadata: AgentMetadata): Promise<bigint> {
    const agentId = await this.erc8004.registerAgent(metadata);
    this.agentId = agentId;
    return agentId;
  }

  /**
   * Register a service for an already-minted agent.
   */
  async registerService(service: Omit<ServiceRegistration, 'agentId'>): Promise<void> {
    if (!this.agentId) throw new Error('Agent not registered. Call mintIdentity() first.');
    await this.erc8004.registerService({ ...service, agentId: this.agentId });
  }

  /**
   * Submit reputation feedback for another agent.
   */
  async giveFeedback(targetAgentId: bigint, score: number, tag1 = '', tag2 = ''): Promise<void> {
    await this.erc8004.giveFeedback({
      agentId: targetAgentId,
      value: score,
      valueDecimals: 2,
      tag1,
      tag2,
    });
  }

  /**
   * Check another agent's reputation before hiring.
   */
  async checkReputation(targetAgentId: bigint, minScore = 0): Promise<boolean> {
    const rep = await this.erc8004.getReputation(targetAgentId);
    return rep.normalizedScore >= minScore;
  }

  /**
   * Discover services by category.
   */
  async discoverServices(category: string) {
    return this.erc8004.discoverServices(category);
  }

  /**
   * Get all active services.
   */
  async getActiveServices() {
    return this.erc8004.getActiveServices();
  }

  // ==========================================================================
  // Visibility & Invite Codes
  // ==========================================================================

  /**
   * Set agent visibility on the marketplace.
   * - 'public': visible to all agents and humans
   * - 'private': only discoverable via invite code
   */
  setVisibility(visibility: AgentVisibility): void {
    this.visibility = visibility;
    if (visibility === 'private') {
      this.inviteCode = this.generateInviteCode();
    } else {
      this.inviteCode = null;
    }
  }

  /**
   * Get the current invite code (only for private agents).
   */
  getInviteCode(): string | null {
    return this.inviteCode;
  }

  /**
   * Validate an invite code against this agent.
   */
  validateInviteCode(code: string): boolean {
    return this.inviteCode !== null && this.inviteCode === code;
  }

  /**
   * Get current visibility setting.
   */
  getVisibility(): AgentVisibility {
    return this.visibility;
  }

  // ==========================================================================
  // Gateway Connection
  // ==========================================================================

  /**
   * Connect to the Veridex Gateway for dashboard monitoring.
   */
  async connectToGateway(metadata: AgentMetadata): Promise<string | null> {
    try {
      const res = await fetch(`${this.gatewayUrl}/api/agents/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: metadata.name,
          category: metadata.category,
          description: metadata.description,
          endpointUrl: metadata.endpointUrl || '',
          ownerAddress: this.signer.address,
          agentId: this.agentId?.toString(),
        }),
      });

      if (!res.ok) return null;
      const data = await res.json() as { id: string };
      this.gatewayId = data.id;
      return data.id;
    } catch {
      console.warn('[AgentRegistrar] Gateway not available, continuing without monitoring.');
      return null;
    }
  }

  /**
   * Report activity to the gateway.
   */
  async reportActivity(type: string, data: Record<string, any> = {}): Promise<void> {
    if (!this.gatewayId) return;
    try {
      await fetch(`${this.gatewayUrl}/api/agents/${this.gatewayId}/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, data }),
      });
    } catch {
      // Non-blocking
    }
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getAgentId(): bigint | null {
    return this.agentId;
  }

  getGatewayId(): string | null {
    return this.gatewayId;
  }

  getSignerAddress(): string {
    return this.signer.address;
  }

  getERC8004Client(): ERC8004Client {
    return this.erc8004;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private generateInviteCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const segments = [];
    for (let s = 0; s < 3; s++) {
      let segment = '';
      for (let i = 0; i < 4; i++) {
        segment += chars[Math.floor(Math.random() * chars.length)];
      }
      segments.push(segment);
    }
    return segments.join('-');
  }

  private buildTokenURI(metadata: AgentMetadata): string {
    const json = JSON.stringify({
      name: metadata.name,
      description: metadata.description,
      category: metadata.category,
      version: metadata.version,
      endpointUrl: metadata.endpointUrl,
      image: metadata.image,
      capabilities: metadata.capabilities,
    });
    return `data:application/json;base64,${Buffer.from(json).toString('base64')}`;
  }
}
