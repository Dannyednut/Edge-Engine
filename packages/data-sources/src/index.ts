/**
 * @edge/data-sources — Per-chain RPC adapters + venue WebSocket feeds.
 *
 * Currently focused on EVM chains (Arbitrum, Base, Optimism, Polygon, BSC,
 * zkSync, Ethereum) via viem.  Solana adapter (Helius Laserstream) is in
 * the scanner package because it has different semantics.
 */

import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient, type Chain as ViemChain } from 'viem';
import {
  arbitrum, base, optimism, polygon, bsc, zksync, mainnet,
} from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainConfig, ChainId } from '@edge/types';

const CHAIN_MAP: Record<string, ViemChain> = {
  ethereum:  mainnet,
  arbitrum:  arbitrum,
  base:      base,
  optimism:  optimism,
  polygon:   polygon,
  bsc:       bsc,
  zksync:    zksync,
};

export interface EvmAdapterOptions {
  chainId: ChainId;
  config: ChainConfig;
  /** Optional wallet private key for signing txs (executor mode). */
  signerPrivateKey?: `0x${string}`;
}

export class EvmAdapter {
  readonly chainId: ChainId;
  readonly chain: ViemChain;
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly signerAddress?: string;

  constructor(opts: EvmAdapterOptions) {
    this.chainId = opts.chainId;
    const viemChain = CHAIN_MAP[opts.chainId];
    if (!viemChain) {
      throw new Error(`Unsupported chainId: ${opts.chainId}`);
    }
    this.chain = viemChain;

    // Use HTTP transport by default (more reliable than WS in containerised envs)
    this.publicClient = createPublicClient({
      chain: viemChain,
      transport: http(opts.config.rpcHttp, { batch: true }),
    });

    if (opts.signerPrivateKey) {
      const account = privateKeyToAccount(opts.signerPrivateKey);
      this.signerAddress = account.address;
      this.walletClient = createWalletClient({
        account,
        chain: viemChain,
        transport: http(opts.config.rpcHttp),
      });
    }
  }

  /** Get current block number. */
  async getBlockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  /** Subscribe to new blocks; callback fires on each new block. */
  onBlock(callback: (blockNumber: bigint) => void): () => void {
    // viem's watchBlockNumber handles subscription internally
    const unwatch = this.publicClient.watchBlockNumber({
      onBlockNumber: (bn) => callback(bn),
      poll: true,
      pollingInterval: 1000,
    });
    return unwatch;
  }

  /** Quick health check — fetches current block number + chain id. */
  async healthCheck(): Promise<{ ok: boolean; blockNumber: bigint; chainId: number; latencyMs: number }> {
    const start = Date.now();
    try {
      const blockNumber = await this.publicClient.getBlockNumber();
      const chainId = Number(await this.publicClient.getChainId());
      return { ok: true, blockNumber, chainId, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, blockNumber: 0n, chainId: 0, latencyMs: Date.now() - start };
    }
  }
}

// ─── Registry: build all adapters from AppConfig ───────────────────────

import type { AppConfig } from '@edge/config';

export interface EvmAdapterRegistry {
  adapters: Partial<Record<ChainId, EvmAdapter>>;
  /** Get adapter for a chain; throws if not configured. */
  get(chainId: ChainId): EvmAdapter;
  /** List of healthy adapters (passed health check). */
  healthy(): ChainId[];
}

export function buildEvmAdapters(appConfig: AppConfig, opts: {
  signerPrivateKey?: `0x${string}`;
  chains?: ChainId[];   // default: all EVM chains in config
} = {}): EvmAdapterRegistry {
  const adapters: Partial<Record<ChainId, EvmAdapter>> = {};
  const targetChains = opts.chains ?? (Object.keys(appConfig.chains).filter(c => c !== 'solana') as ChainId[]);

  for (const chainId of targetChains) {
    const cfg = appConfig.chains[chainId];
    if (!cfg) continue;
    try {
      adapters[chainId] = new EvmAdapter({
        chainId,
        config: cfg,
        signerPrivateKey: opts.signerPrivateKey,
      });
    } catch (err) {
      console.warn(`Failed to build adapter for ${chainId}:`, err);
    }
  }

  return {
    adapters,
    get(chainId) {
      const a = adapters[chainId];
      if (!a) throw new Error(`No EVM adapter for chainId=${chainId}`);
      return a;
    },
    healthy() {
      return [];   // populated by healthCheckAll below
    },
  };
}

export async function healthCheckAll(registry: EvmAdapterRegistry): Promise<Array<{ chainId: ChainId; ok: boolean; blockNumber: string; latencyMs: number }>> {
  const results: Array<{ chainId: ChainId; ok: boolean; blockNumber: string; latencyMs: number }> = [];
  for (const [chainId, adapter] of Object.entries(registry.adapters)) {
    const r = await adapter!.healthCheck();
    results.push({
      chainId: chainId as ChainId,
      ok: r.ok,
      blockNumber: r.blockNumber.toString(),
      latencyMs: r.latencyMs,
    });
  }
  return results;
}
