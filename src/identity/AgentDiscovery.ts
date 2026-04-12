/**
 * @packageDocumentation
 * @module identity/AgentDiscovery
 * @description
 * Agent discovery and resolution across chains.
 * 
 * Provides:
 * - Search agents by capability, chain, and reputation threshold
 * - Resolve agent identity from endpoint URL, chain address, or UAI
 * - Domain-based resolution via /.well-known/agent-registration.json
 * - (Future) Relayer-indexed search across all chains
 * 
 * References:
 * - ADR-0029 §Phase 3 AgentDiscovery
 * - UATL paper §8 Unified Identity Resolution Protocol
 */
import { IdentityClient } from './IdentityClient';
import { ReputationClient } from './ReputationClient';
import type {
  DiscoveryQuery,
  AgentRegistration,
  ResolvedAgent,
  ChainPresence,
  AgentRegistrationFile,
  UniversalAgentIdentifier,
  WellKnownAgentRegistration,
  ERC8004Config,
} from './types';

// ============================================================================
// AgentDiscovery
// ============================================================================

export class AgentDiscovery {
  private identityClient: IdentityClient;
  private reputationClient: ReputationClient;
  private relayerUrl?: string;

  constructor(
    identityClient: IdentityClient,
    reputationClient: ReputationClient,
    config?: { relayerUrl?: string },
  ) {
    this.identityClient = identityClient;
    this.reputationClient = reputationClient;
    this.relayerUrl = config?.relayerUrl;
  }

  // ==========================================================================
  // Search
  // ==========================================================================

  /**
   * Search for agents matching a query.
   * 
   * Currently delegates to the Relayer API if available.
   * Falls back to on-chain enumeration (limited).
   */
  async search(query: DiscoveryQuery): Promise<AgentRegistration[]> {
    // Strategy 1: Use Relayer indexer API if available
    if (this.relayerUrl) {
      return this.searchViaRelayer(query);
    }

    // Strategy 2: On-chain enumeration (limited — no capability index on-chain)
    // This is a placeholder; real discovery requires an indexer
    return [];
  }

  /**
   * Search via the Veridex Relayer's agent indexer API.
   */
  private async searchViaRelayer(query: DiscoveryQuery): Promise<AgentRegistration[]> {
    try {
      const params = new URLSearchParams();
      if (query.capability) params.set('capability', query.capability);
      if (query.chain) params.set('chain', query.chain);
      if (query.minReputation !== undefined) params.set('minReputation', String(query.minReputation));
      if (query.limit !== undefined) params.set('limit', String(query.limit));

      const res = await fetch(`${this.relayerUrl}/api/v1/trust/discover?${params}`);
      if (!res.ok) return [];

      const data = await res.json() as any[];
      return data.map((d: any) => ({
        agentId: BigInt(d.agentId),
        owner: d.owner,
        agentURI: d.agentURI,
        agentWallet: d.agentWallet || '',
      }));
    } catch {
      return [];
    }
  }

  // ==========================================================================
  // Resolution
  // ==========================================================================

  /**
   * Resolve an agent from any input: UAI, endpoint URL, chain address, or name.
   * 
   * Resolution hierarchy (per UATL paper §8.2):
   * 1. If UAI → fetch registration file directly
   * 2. If endpoint URL → check /.well-known/agent-registration.json
   * 3. If chain address → query Relayer index
   * 4. If name/search term → search Relayer
   */
  async resolve(input: string): Promise<ResolvedAgent | null> {
    if (AgentDiscovery.isUAI(input)) {
      return this.resolveFromUAI(input);
    }
    if (AgentDiscovery.isURL(input)) {
      return this.resolveFromEndpoint(input);
    }
    if (AgentDiscovery.isAddress(input)) {
      return this.resolveFromAddress(input);
    }
    return this.resolveFromSearch(input);
  }

  /**
   * Resolve from a Universal Agent Identifier.
   * Format: {namespace}:{chainReference}:{registryAddress}:{agentId}
   */
  async resolveFromUAI(uai: UniversalAgentIdentifier): Promise<ResolvedAgent | null> {
    const parts = uai.split(':');
    if (parts.length < 4) return null;

    const agentId = BigInt(parts[parts.length - 1]);

    try {
      const agent = await this.identityClient.getAgent(agentId);
      const regFile = await this.fetchRegistrationFile(agent.agentURI);

      return {
        canonicalUAI: uai,
        agentId,
        registrationFile: regFile || AgentDiscovery.emptyRegistrationFile(),
        chainPresence: regFile
          ? this.extractChainPresence(regFile)
          : [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve from a service endpoint URL via /.well-known/agent-registration.json
   */
  async resolveFromEndpoint(endpoint: string): Promise<ResolvedAgent | null> {
    try {
      const domain = new URL(endpoint).hostname;
      const res = await fetch(`https://${domain}/.well-known/agent-registration.json`);
      if (!res.ok) return null;

      const wellKnown = await res.json() as WellKnownAgentRegistration;
      if (!wellKnown.agentId) return null;

      const agentId = BigInt(wellKnown.agentId);
      const agent = await this.identityClient.getAgent(agentId);
      const regFile = await this.fetchRegistrationFile(agent.agentURI);

      return {
        canonicalUAI: wellKnown.canonicalUAI || `eip155:unknown:${this.identityClient.getRegistryAddress()}:${agentId}`,
        agentId,
        registrationFile: regFile || AgentDiscovery.emptyRegistrationFile(),
        chainPresence: regFile ? this.extractChainPresence(regFile) : [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve from a chain address via Relayer index.
   */
  async resolveFromAddress(address: string): Promise<ResolvedAgent | null> {
    if (!this.relayerUrl) return null;

    try {
      const res = await fetch(`${this.relayerUrl}/api/v1/trust/resolve/${address}`);
      if (!res.ok) return null;

      const data = await res.json() as any;
      return {
        canonicalUAI: data.canonicalUAI,
        agentId: BigInt(data.agentId),
        registrationFile: data.registrationFile || AgentDiscovery.emptyRegistrationFile(),
        chainPresence: data.chainPresence || [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve from a search term (name, ENS, DID).
   */
  async resolveFromSearch(term: string): Promise<ResolvedAgent | null> {
    const results = await this.search({ capability: term, limit: 1 });
    if (results.length === 0) return null;

    const agent = results[0];
    const regFile = await this.fetchRegistrationFile(agent.agentURI);

    return {
      canonicalUAI: `eip155:unknown:${this.identityClient.getRegistryAddress()}:${agent.agentId}`,
      agentId: agent.agentId,
      registrationFile: regFile || AgentDiscovery.emptyRegistrationFile(),
      chainPresence: regFile ? this.extractChainPresence(regFile) : [],
    };
  }

  /**
   * Resolve from a domain's well-known file.
   */
  async resolveFromDomain(domain: string): Promise<AgentRegistration | null> {
    return this.identityClient.resolveAgentFromEndpoint(`https://${domain}`);
  }

  /**
   * Find agents by service name (e.g., "sentiment", "oracle").
   */
  async findByService(
    serviceName: string,
    options?: { minReputation?: number; chain?: string },
  ): Promise<AgentRegistration[]> {
    return this.search({
      capability: serviceName,
      minReputation: options?.minReputation,
      chain: options?.chain,
    });
  }

  // ==========================================================================
  // Static Helpers
  // ==========================================================================

  static isUAI(input: string): boolean {
    // UAI format: {namespace}:{chainRef}:{address}:{agentId}
    const parts = input.split(':');
    return parts.length >= 4 && /^\d+$/.test(parts[parts.length - 1]);
  }

  static isURL(input: string): boolean {
    try {
      new URL(input);
      return true;
    } catch {
      return false;
    }
  }

  static isAddress(input: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(input);
  }

  static emptyRegistrationFile(): AgentRegistrationFile {
    return {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: '',
      description: '',
      services: [],
      x402Support: false,
      active: false,
      registrations: [],
    };
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /**
   * Fetch and parse a registration file from a URI (IPFS or data URI).
   */
  private async fetchRegistrationFile(uri: string): Promise<AgentRegistrationFile | null> {
    if (!uri) return null;

    try {
      if (uri.startsWith('data:')) {
        // Data URI — decode base64
        const base64 = uri.split(',')[1];
        if (!base64) return null;
        const json = Buffer.from(base64, 'base64').toString('utf-8');
        return JSON.parse(json);
      }

      if (uri.startsWith('ipfs://')) {
        // IPFS — use public gateway
        const cid = uri.replace('ipfs://', '');
        const res = await fetch(`https://ipfs.io/ipfs/${cid}`);
        if (!res.ok) return null;
        return res.json();
      }

      if (uri.startsWith('http')) {
        const res = await fetch(uri);
        if (!res.ok) return null;
        return res.json();
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract chain presence from a registration file's registrations array.
   */
  private extractChainPresence(file: AgentRegistrationFile): ChainPresence[] {
    return (file.registrations || []).map(ref => {
      const parts = ref.agentRegistry.split(':');
      const namespace = parts[0] || '';
      const chainRef = parts[1] || '';
      const registryAddress = parts[2] || '';

      let strategy: 'erc8004' | 'native-program' | 'relayer-attested' = 'erc8004';
      if (namespace === 'solana' || namespace === 'aptos' || namespace === 'sui') {
        strategy = 'native-program';
      } else if (namespace === 'stacks' || namespace === 'starknet') {
        strategy = 'relayer-attested';
      }

      return {
        chain: `${namespace}:${chainRef}`,
        registryAddress,
        localAgentId: BigInt(ref.agentId),
        strategy,
      };
    });
  }
}
