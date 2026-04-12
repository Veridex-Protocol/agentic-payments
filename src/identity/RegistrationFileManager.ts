/**
 * @packageDocumentation
 * @module identity/RegistrationFileManager
 * @description
 * Builds, validates, publishes, and manages ERC-8004 agent registration files.
 * 
 * The registration file is a JSON document published at the agentURI (IPFS or
 * data URI) that describes the agent's services, capabilities, and cross-chain
 * registrations. It follows the schema defined in ERC-8004:
 * https://eips.ethereum.org/EIPS/eip-8004#registration-v1
 * 
 * This class handles:
 * - Building registration files from options
 * - Validating registration files against the schema
 * - Publishing to IPFS (Pinata / web3.storage) or encoding as data URIs
 * - Managing service endpoints and chain registrations
 * - Building /.well-known/agent-registration.json files
 * 
 * References:
 * - ADR-0029 §1.3 RegistrationFileManager
 * - ERC8004_IMPLEMENTATION_PLAN.md Phase 1
 */
import type {
  AgentRegistrationFile,
  ServiceEndpoint,
  AgentRegistryRef,
  RegisterAgentOptions,
  WellKnownAgentRegistration,
  UniversalAgentIdentifier,
  ERC8004Config,
} from './types';

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ============================================================================
// RegistrationFileManager
// ============================================================================

export class RegistrationFileManager {
  private ipfsConfig?: ERC8004Config['ipfs'];

  constructor(config?: { ipfs?: ERC8004Config['ipfs'] }) {
    this.ipfsConfig = config?.ipfs;
  }

  // ==========================================================================
  // Build
  // ==========================================================================

  /**
   * Build an ERC-8004 compliant registration file from options.
   */
  static buildRegistrationFile(options: RegisterAgentOptions): AgentRegistrationFile {
    return {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: options.name,
      description: options.description,
      image: options.image,
      services: options.services || [],
      x402Support: options.x402Support ?? true,
      active: true,
      registrations: [],
      supportedTrust: options.supportedTrust || ['reputation'],
    };
  }

  // ==========================================================================
  // Validate
  // ==========================================================================

  /**
   * Validate a registration file against the ERC-8004 schema.
   */
  static validate(file: AgentRegistrationFile): ValidationResult {
    const errors: string[] = [];

    if (!file.type) {
      errors.push('Missing required field: type');
    } else if (!file.type.includes('eip-8004')) {
      errors.push(`Invalid type: expected ERC-8004 registration type, got "${file.type}"`);
    }

    if (!file.name || file.name.trim().length === 0) {
      errors.push('Missing required field: name');
    }

    if (!file.description || file.description.trim().length === 0) {
      errors.push('Missing required field: description');
    }

    if (typeof file.active !== 'boolean') {
      errors.push('Missing required field: active (must be boolean)');
    }

    if (!Array.isArray(file.services)) {
      errors.push('Missing required field: services (must be array)');
    } else {
      for (let i = 0; i < file.services.length; i++) {
        const svc = file.services[i];
        if (!svc.name) errors.push(`services[${i}]: missing name`);
        if (!svc.endpoint) errors.push(`services[${i}]: missing endpoint`);
      }
    }

    if (!Array.isArray(file.registrations)) {
      errors.push('Missing required field: registrations (must be array)');
    } else {
      for (let i = 0; i < file.registrations.length; i++) {
        const reg = file.registrations[i];
        if (reg.agentId === undefined || reg.agentId === null) {
          errors.push(`registrations[${i}]: missing agentId`);
        }
        if (!reg.agentRegistry) {
          errors.push(`registrations[${i}]: missing agentRegistry`);
        } else if (!reg.agentRegistry.includes(':')) {
          errors.push(`registrations[${i}]: agentRegistry must be CAIP-2 format (e.g., eip155:8453:0x...)`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ==========================================================================
  // Publish
  // ==========================================================================

  /**
   * Publish a registration file to IPFS.
   * Requires ipfs config (gateway, apiKey, provider).
   * 
   * @returns IPFS URI (ipfs://...)
   */
  async publishToIPFS(file: AgentRegistrationFile): Promise<string> {
    if (!this.ipfsConfig) {
      throw new Error('RegistrationFileManager: IPFS config required for publishToIPFS(). Set ipfs in constructor config.');
    }

    const json = JSON.stringify(file, null, 2);

    if (this.ipfsConfig.provider === 'pinata') {
      return this.pinToPinata(json);
    } else if (this.ipfsConfig.provider === 'web3storage') {
      return this.pinToWeb3Storage(json);
    }

    throw new Error(`RegistrationFileManager: unsupported IPFS provider "${this.ipfsConfig.provider}"`);
  }

  /**
   * Encode a registration file as a data URI for fully on-chain storage.
   * No external dependencies required.
   */
  static buildDataURI(file: AgentRegistrationFile): string {
    const json = JSON.stringify(file);
    return `data:application/json;base64,${Buffer.from(json).toString('base64')}`;
  }

  /**
   * Parse a registration file from a URI (data URI, IPFS, or HTTPS).
   */
  static async fetchFromURI(uri: string): Promise<AgentRegistrationFile | null> {
    if (!uri) return null;

    try {
      if (uri.startsWith('data:')) {
        const base64 = uri.split(',')[1];
        if (!base64) return null;
        const json = Buffer.from(base64, 'base64').toString('utf-8');
        return JSON.parse(json);
      }

      if (uri.startsWith('ipfs://')) {
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

  // ==========================================================================
  // Endpoint Management
  // ==========================================================================

  /**
   * Add a service endpoint to a registration file.
   */
  static addService(file: AgentRegistrationFile, service: ServiceEndpoint): AgentRegistrationFile {
    return {
      ...file,
      services: [...file.services, service],
    };
  }

  /**
   * Remove a service endpoint by name.
   */
  static removeService(file: AgentRegistrationFile, serviceName: string): AgentRegistrationFile {
    return {
      ...file,
      services: file.services.filter(s => s.name !== serviceName),
    };
  }

  /**
   * Add a chain registration reference.
   */
  static addRegistration(file: AgentRegistrationFile, ref: AgentRegistryRef): AgentRegistrationFile {
    return {
      ...file,
      registrations: [...file.registrations, ref],
    };
  }

  /**
   * Remove a chain registration by agentRegistry identifier.
   */
  static removeRegistration(file: AgentRegistrationFile, agentRegistry: string): AgentRegistrationFile {
    return {
      ...file,
      registrations: file.registrations.filter(r => r.agentRegistry !== agentRegistry),
    };
  }

  // ==========================================================================
  // Well-Known File
  // ==========================================================================

  /**
   * Build the /.well-known/agent-registration.json content.
   * This file should be served at the agent's domain for zero-lookup resolution.
   */
  static buildWellKnownFile(
    agentId: number,
    canonicalUAI: UniversalAgentIdentifier,
    registrationFileURI: string,
    relayerUrl?: string,
  ): WellKnownAgentRegistration {
    return {
      agentId,
      canonicalUAI,
      registrationFileURI,
      veridexRelayer: relayerUrl,
    };
  }

  // ==========================================================================
  // Private — IPFS Pinning
  // ==========================================================================

  private async pinToPinata(json: string): Promise<string> {
    const res = await fetch(`${this.ipfsConfig!.gateway}/pinning/pinJSONToIPFS`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.ipfsConfig!.apiKey}`,
      },
      body: JSON.stringify({
        pinataContent: JSON.parse(json),
        pinataMetadata: { name: 'agent-registration.json' },
      }),
    });

    if (!res.ok) {
      throw new Error(`Pinata pinning failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { IpfsHash: string };
    return `ipfs://${data.IpfsHash}`;
  }

  private async pinToWeb3Storage(json: string): Promise<string> {
    const res = await fetch(`${this.ipfsConfig!.gateway}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.ipfsConfig!.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: json,
    });

    if (!res.ok) {
      throw new Error(`web3.storage upload failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { cid: string };
    return `ipfs://${data.cid}`;
  }
}
