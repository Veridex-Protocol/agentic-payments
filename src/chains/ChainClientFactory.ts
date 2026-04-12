/**
 * @packageDocumentation
 * @module ChainClientFactory
 * @description
 * Factory pattern for creating chain-specific Agent Clients.
 * 
 * This factory abstracts the instantiation complexity of various chain clients (EVM, Solana, Starknet, etc.).
 * It uses the Veridex `ChainPreset` configuration to automatically inject the correct contract addresses,
 * RPC URLs, and bridge configurations for the requested network environment (Mainnet/Testnet).
 * 
 * Usage:
 * ```typescript
 * const client = ChainClientFactory.createClient('base', 'mainnet');
 * ```
 */
import {
    getChainPreset,
    ChainName,
    NetworkType,
} from '@veridex/sdk';
import { EVMClientConfig } from '@veridex/sdk/chains/evm';
import { SolanaClientConfig } from '@veridex/sdk/chains/solana';
import { AptosClientConfig } from '@veridex/sdk/chains/aptos';
import { SuiClientConfig } from '@veridex/sdk/chains/sui';
import { StarknetClientConfig } from '@veridex/sdk/chains/starknet';
import { AgentChainClient } from './ChainClient';
import { EVMChainClient } from './EVMChainClient';
import { SolanaChainClient } from './SolanaChainClient';
import { AptosChainClient } from './AptosChainClient';
import { SuiChainClient } from './SuiChainClient';
import { StarknetChainClient } from './StarknetChainClient';
import { StacksChainClient } from './StacksChainClient';
import { MonadChainClient } from './MonadChainClient';
import { AvalancheChainClient } from './AvalancheChainClient';

/**
 * Factory for creating AgentChainClient instances.
 */
export class ChainClientFactory {
    /**
     * Create an agent chain client for a specific chain and network.
     */
    static createClient(
        chain: ChainName,
        network: NetworkType = 'testnet',
        customRpcUrl?: string
    ): AgentChainClient {
        const preset = getChainPreset(chain);
        const config = preset[network];
        const rpcUrl = customRpcUrl || config.rpcUrl;

        const requireString = (value: string | undefined, label: string): string => {
            if (!value) {
                throw new Error(`Missing ${label} for chain "${chain}" on network "${network}"`);
            }
            return value;
        };

        // Special case: Monad gets its own client with Agent Gateway support
        if ((chain as string) === 'monad') {
            return new MonadChainClient({
                chainId: config.chainId,
                wormholeChainId: config.wormholeChainId,
                rpcUrl,
                hubContractAddress: config.contracts.hub || '0x0000000000000000000000000000000000000000',
                wormholeCoreBridge: config.contracts.wormholeCoreBridge || '0x0000000000000000000000000000000000000000',
                vaultFactory: config.contracts.vaultFactory,
                vaultImplementation: config.contracts.vaultImplementation,
                name: config.name,
                explorerUrl: config.explorerUrl,
                serviceDirectoryAddress: (config.contracts as any).serviceDirectory,
            });
        }

        // Special case: Avalanche gets its own client with ACP-204 + ICM + Chainlink
        if ((chain as string) === 'avalanche') {
            return new AvalancheChainClient({
                chainId: config.chainId,
                wormholeChainId: config.wormholeChainId,
                rpcUrl,
                hubContractAddress: config.contracts.hub || '0x0000000000000000000000000000000000000000',
                wormholeCoreBridge: config.contracts.wormholeCoreBridge || '0x0000000000000000000000000000000000000000',
                vaultFactory: config.contracts.vaultFactory,
                vaultImplementation: config.contracts.vaultImplementation,
                tokenBridge: config.contracts.tokenBridge,
                name: config.name,
                explorerUrl: config.explorerUrl,
                chainlinkAvaxUsdFeed: (config.contracts as any).chainlinkAvaxUsd,
                chainlinkUsdcUsdFeed: (config.contracts as any).chainlinkUsdcUsd,
                chainlinkUsdtUsdFeed: (config.contracts as any).chainlinkUsdtUsd,
                p256VerifierAddress: (config.contracts as any).p256Verifier,
                icmSpokeAddress: (config.contracts as any).icmSpoke,
            });
        }

        switch (preset.type) {
            case 'evm':
                return new EVMChainClient({
                    chainId: config.chainId,
                    wormholeChainId: config.wormholeChainId,
                    rpcUrl,
                    hubContractAddress: requireString(config.contracts.hub, 'hub contract address'),
                    wormholeCoreBridge: requireString(config.contracts.wormholeCoreBridge, 'Wormhole core bridge address'),
                    vaultFactory: config.contracts.vaultFactory,
                    vaultImplementation: config.contracts.vaultImplementation,
                    tokenBridge: config.contracts.tokenBridge,
                    name: config.name,
                    explorerUrl: config.explorerUrl,
                } as EVMClientConfig);

            case 'solana':
                return new SolanaChainClient({
                    rpcUrl,
                    programId: requireString(config.contracts.hub, 'programId'),
                    wormholeCoreBridge: requireString(config.contracts.wormholeCoreBridge, 'Wormhole core bridge address'),
                    tokenBridge: requireString(config.contracts.tokenBridge, 'token bridge address'),
                    wormholeChainId: config.wormholeChainId,
                    network: network === 'testnet' ? 'devnet' : 'mainnet',
                } as SolanaClientConfig);

            case 'aptos':
                return new AptosChainClient({
                    rpcUrl,
                    moduleAddress: requireString(config.contracts.hub, 'moduleAddress'),
                    wormholeCoreBridge: requireString(config.contracts.wormholeCoreBridge, 'Wormhole core bridge address'),
                    tokenBridge: requireString(config.contracts.tokenBridge, 'token bridge address'),
                    wormholeChainId: config.wormholeChainId,
                    network: network,
                } as AptosClientConfig);

            case 'sui':
                return new SuiChainClient({
                    rpcUrl,
                    packageId: requireString(config.contracts.hub, 'packageId'),
                    wormholeCoreBridge: requireString(config.contracts.wormholeCoreBridge, 'Wormhole core bridge address'),
                    wormholeChainId: config.wormholeChainId,
                    network: network,
                } as SuiClientConfig);

            case 'starknet':
                return new StarknetChainClient({
                    rpcUrl,
                    spokeContractAddress: config.contracts.hub,
                    bridgeContractAddress: config.contracts.wormholeCoreBridge,
                    wormholeChainId: config.wormholeChainId,
                    network: network === 'testnet' ? 'sepolia' : 'mainnet',
                } as StarknetClientConfig);

            case 'stacks':
                return new StacksChainClient({
                    rpcUrl,
                    spokeContractAddress: config.contracts.hub || undefined,
                    wormholeChainId: config.wormholeChainId,
                    network: network,
                });

            default:
                throw new Error(`Chain type "${preset.type}" is not supported by legacy AgentChainClient.`);
        }
    }
}
