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

            default:
                throw new Error(`Chain type "${preset.type}" is not supported by legacy AgentChainClient.`);
        }
    }
}
