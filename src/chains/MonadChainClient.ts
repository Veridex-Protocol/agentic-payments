/**
 * @packageDocumentation
 * @module MonadChainClient
 * @description
 * Agent adapter for Monad blockchain with Agent Gateway support.
 * 
 * Extends EVMChainClient with Monad-specific features:
 * - On-chain service discovery via VeridexServiceDirectory
 * - ERC-8004 identity and reputation queries
 * - Agent marketplace integration
 * - EIP-7951 P256 precompile support (native passkey verification)
 */
import { EVMClient as CoreEVMClient, EVMClientConfig as CoreEVMClientConfig } from '@veridex/sdk/chains/evm';
import { BaseAgentChainClient } from './ChainClient';
import { ethers } from 'ethers';

// ============================================================================
// ERC-8004 Registry Addresses (Canonical Singletons — same on all testnets)
// ============================================================================

export const ERC8004_TESTNET_IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const ERC8004_TESTNET_REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

// ============================================================================
// Minimal ABIs for on-chain queries
// ============================================================================

const SERVICE_DIRECTORY_ABI = [
    'function getServicesByCategory(string category) view returns (tuple(uint256 serviceId, uint256 agentId, address agent, string endpointUrl, string category, string description, uint256 pricePerCall, address paymentToken, bool active, uint256 registeredAt)[])',
    'function getActiveServices() view returns (tuple(uint256 serviceId, uint256 agentId, address agent, string endpointUrl, string category, string description, uint256 pricePerCall, address paymentToken, bool active, uint256 registeredAt)[])',
    'function totalServices() view returns (uint256)',
    'function totalCategories() view returns (uint256)',
];

const IDENTITY_REGISTRY_ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function balanceOf(address owner) view returns (uint256)',
];

const REPUTATION_REGISTRY_ABI = [
    'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint256 count, int128 summaryValue, uint8 summaryValueDecimals)',
    'function getClients(uint256 agentId) view returns (address[])',
];

// ============================================================================
// Types
// ============================================================================

export interface ServiceInfo {
    serviceId: bigint;
    agentId: bigint;
    agent: string;
    endpointUrl: string;
    category: string;
    description: string;
    pricePerCall: bigint;
    paymentToken: string;
    active: boolean;
    registeredAt: bigint;
}

export interface ReputationSummary {
    count: bigint;
    summaryValue: bigint;
    summaryValueDecimals: number;
}

export interface MonadChainClientConfig extends CoreEVMClientConfig {
    serviceDirectoryAddress?: string;
    identityRegistryAddress?: string;
    reputationRegistryAddress?: string;
}

// ============================================================================
// MonadChainClient
// ============================================================================

/**
 * Agent-specific Monad chain client with Agent Gateway support.
 * 
 * Provides on-chain service discovery, ERC-8004 identity/reputation queries,
 * and agent marketplace integration on top of standard EVM functionality.
 * 
 * @example
 * ```typescript
 * import { MonadChainClient } from '@veridex/agentic-payments';
 * 
 * const client = new MonadChainClient({
 *   chainId: 10143,
 *   wormholeChainId: 10048,
 *   rpcUrl: 'https://testnet-rpc.monad.xyz',
 *   hubContractAddress: '0x0000000000000000000000000000000000000000',
 *   wormholeCoreBridge: '0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd',
 *   serviceDirectoryAddress: '0x0D2B4193e78107678a5aC29d795e0EcD361aE3A7',
 * });
 * 
 * // Discover sentiment analysis agents
 * const agents = await client.discoverServices('sentiment');
 * 
 * // Check agent reputation
 * const rep = await client.getAgentReputation(agents[0].agentId);
 * ```
 */
export class MonadChainClient extends BaseAgentChainClient {
    private evmCore: CoreEVMClient;
    private provider: ethers.JsonRpcProvider;
    private serviceDirectoryAddress: string;
    private identityRegistryAddress: string;
    private reputationRegistryAddress: string;

    constructor(config: MonadChainClientConfig) {
        const core = new CoreEVMClient(config);
        super(core);
        this.evmCore = core;
        this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
        this.serviceDirectoryAddress = config.serviceDirectoryAddress || '';
        this.identityRegistryAddress = config.identityRegistryAddress || ERC8004_TESTNET_IDENTITY;
        this.reputationRegistryAddress = config.reputationRegistryAddress || ERC8004_TESTNET_REPUTATION;
    }

    // ========================================================================
    // Service Discovery (VeridexServiceDirectory)
    // ========================================================================

    /**
     * Discover services by category from the on-chain ServiceDirectory.
     */
    async discoverServices(category: string): Promise<ServiceInfo[]> {
        if (!this.serviceDirectoryAddress) {
            throw new Error('ServiceDirectory address not configured');
        }
        const contract = new ethers.Contract(
            this.serviceDirectoryAddress,
            SERVICE_DIRECTORY_ABI,
            this.provider,
        );
        const raw = await contract.getServicesByCategory(category);
        return raw.map(this.parseService);
    }

    /**
     * Get all active services from the on-chain ServiceDirectory.
     */
    async getActiveServices(): Promise<ServiceInfo[]> {
        if (!this.serviceDirectoryAddress) {
            throw new Error('ServiceDirectory address not configured');
        }
        const contract = new ethers.Contract(
            this.serviceDirectoryAddress,
            SERVICE_DIRECTORY_ABI,
            this.provider,
        );
        const raw = await contract.getActiveServices();
        return raw.map(this.parseService);
    }

    /**
     * Get total number of registered services.
     */
    async getTotalServices(): Promise<bigint> {
        if (!this.serviceDirectoryAddress) return 0n;
        const contract = new ethers.Contract(
            this.serviceDirectoryAddress,
            SERVICE_DIRECTORY_ABI,
            this.provider,
        );
        return contract.totalServices();
    }

    /**
     * Get total number of service categories.
     */
    async getTotalCategories(): Promise<bigint> {
        if (!this.serviceDirectoryAddress) return 0n;
        const contract = new ethers.Contract(
            this.serviceDirectoryAddress,
            SERVICE_DIRECTORY_ABI,
            this.provider,
        );
        return contract.totalCategories();
    }

    // ========================================================================
    // ERC-8004 Identity Registry
    // ========================================================================

    /**
     * Get the owner of an ERC-8004 agent identity NFT.
     */
    async getAgentOwner(agentId: bigint): Promise<string> {
        const contract = new ethers.Contract(
            this.identityRegistryAddress,
            IDENTITY_REGISTRY_ABI,
            this.provider,
        );
        return contract.ownerOf(agentId);
    }

    /**
     * Get the metadata URI for an agent identity.
     */
    async getAgentURI(agentId: bigint): Promise<string> {
        const contract = new ethers.Contract(
            this.identityRegistryAddress,
            IDENTITY_REGISTRY_ABI,
            this.provider,
        );
        return contract.tokenURI(agentId);
    }

    /**
     * Check how many agent identities an address owns.
     */
    async getAgentCount(owner: string): Promise<bigint> {
        const contract = new ethers.Contract(
            this.identityRegistryAddress,
            IDENTITY_REGISTRY_ABI,
            this.provider,
        );
        return contract.balanceOf(owner);
    }

    // ========================================================================
    // ERC-8004 Reputation Registry
    // ========================================================================

    /**
     * Get reputation summary for an agent.
     */
    async getAgentReputation(agentId: bigint, tag1 = '', tag2 = ''): Promise<ReputationSummary> {
        try {
            const contract = new ethers.Contract(
                this.reputationRegistryAddress,
                REPUTATION_REGISTRY_ABI,
                this.provider,
            );
            const [count, summaryValue, summaryValueDecimals] = await contract.getSummary(
                agentId, [], tag1, tag2,
            );
            return { count, summaryValue, summaryValueDecimals };
        } catch {
            // Testnet registry may not be fully initialized
            return { count: 0n, summaryValue: 0n, summaryValueDecimals: 0 };
        }
    }

    /**
     * Get all clients who have given feedback to an agent.
     */
    async getAgentClients(agentId: bigint): Promise<string[]> {
        try {
            const contract = new ethers.Contract(
                this.reputationRegistryAddress,
                REPUTATION_REGISTRY_ABI,
                this.provider,
            );
            return contract.getClients(agentId);
        } catch {
            return [];
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Get the underlying ethers provider.
     */
    getProvider(): ethers.JsonRpcProvider {
        return this.provider;
    }

    /**
     * Get the ServiceDirectory contract address.
     */
    getServiceDirectoryAddress(): string {
        return this.serviceDirectoryAddress;
    }

    /**
     * Get the ERC-8004 Identity Registry address.
     */
    getIdentityRegistryAddress(): string {
        return this.identityRegistryAddress;
    }

    /**
     * Get the ERC-8004 Reputation Registry address.
     */
    getReputationRegistryAddress(): string {
        return this.reputationRegistryAddress;
    }

    private parseService(raw: any): ServiceInfo {
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
