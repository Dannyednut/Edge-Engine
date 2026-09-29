/**
 * Uniswap V3 View Quoter — wraps the official Uniswap view-quoter-v3 contract.
 *
 * Why view-quoter-v3 (not the standard Quoter):
 *   - Standard Quoter's `quoteExactInputSingle` is a non-view function — it
 *     uses `pool.swap()` with a revert trick to compute the output. This
 *     requires `client.call()` with manual ABI decoding in viem.
 *   - view-quoter-v3 rewrites the swap math (SwapMath / SqrtPriceMath /
 *     TickMath / LiquidityMath) as pure `view` functions. `readContract()`
 *     works natively — typed returns, multicall-friendly, no override hack.
 *
 * Source: https://github.com/Uniswap/view-quoter-v3
 * Status: not audited, but actively shadow-tested in Uniswap's routing-api.
 *
 * Deployment addresses (from the repo's README):
 *   - Ethereum mainnet, Arbitrum, Optimism, Polygon, BSC: 0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3
 *   - Base (chainId 8453):                                0x222ca98f00ed15b1fae10b61c277703a194cf5d2
 *   - Also: Celo, Avalanche, Blast, Zora (we don't use these)
 */

import type { PublicClient, Address } from 'viem';
import type { ChainId } from '@edge/types';

export const VIEW_QUOTER_V3_ADDRESSES: Record<string, Address | null> = {
  ethereum:  '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
  arbitrum:  '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
  base:      '0x222ca98f00ed15b1fae10b61c277703a194cf5d2',
  optimism:  '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
  polygon:   '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
  bsc:       '0x5e55c9e631fae526cd4b0526c4818d6e0a9ef0e3',
  zksync:    null,
  solana:    null,
};

export const VIEW_QUOTER_V3_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',  type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee',      type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut',                type: 'uint256' },
      { name: 'sqrtPriceX96After',        type: 'uint160' },
      { name: 'initializedTicksCrossed',  type: 'uint32' },
      { name: 'gasEstimate',              type: 'uint256' },
    ],
  },
  {
    name: 'quoteExactInput',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'path',     type: 'bytes' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountOut',                  type: 'uint256' },
      { name: 'sqrtPriceX96AfterList',      type: 'uint160[]' },
      { name: 'initializedTicksCrossedList',type: 'uint32[]' },
      { name: 'gasEstimate',                type: 'uint256' },
    ],
  },
] as const;

export interface QuoteExactInputSingleParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fee: number;
  sqrtPriceLimitX96?: bigint;
}

export interface QuoteResult {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
}

export class UniswapViewQuoter {
  readonly address: Address;
  readonly chainId: ChainId;
  private _decimalsCache = new Map<Address, number>();

  constructor(
    private client: PublicClient,
    chainId: ChainId,
  ) {
    const addr = VIEW_QUOTER_V3_ADDRESSES[chainId];
    if (!addr) {
      throw new Error(`UniswapViewQuoter: view-quoter-v3 not deployed on chain "${chainId}"`);
    }
    this.address = addr;
    this.chainId = chainId;
  }

  async quoteExactInputSingle(params: QuoteExactInputSingleParams): Promise<QuoteResult> {
    const result = await this.client.readContract({
      address: this.address,
      abi: VIEW_QUOTER_V3_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountIn,
          fee: params.fee,
          sqrtPriceLimitX96: params.sqrtPriceLimitX96 ?? 0n,
        },
      ],
    }) as [bigint, bigint, number, bigint];

    return {
      amountOut: result[0],
      sqrtPriceX96After: result[1],
      initializedTicksCrossed: result[2],
      gasEstimate: result[3],
    };
  }

  async quoteExactInput(path: `0x${string}`, amountIn: bigint): Promise<QuoteResult> {
    const result = await this.client.readContract({
      address: this.address,
      abi: VIEW_QUOTER_V3_ABI,
      functionName: 'quoteExactInput',
      args: [path, amountIn],
    }) as [bigint, bigint[], number[], bigint];

    return {
      amountOut: result[0],
      sqrtPriceX96After: result[1][0] ?? 0n,
      initializedTicksCrossed: result[2][0] ?? 0,
      gasEstimate: result[3],
    };
  }

  /**
   * Quote the same swap across multiple fee tiers (500, 3000, 10000) and
   * return the best (highest output). Useful when we don't know which pool
   * has the deepest liquidity for a given pair.
   */
  async quoteBestFeeTier(params: Omit<QuoteExactInputSingleParams, 'fee'>): Promise<{ best: QuoteResult; bestFee: number; all: Array<{ fee: number; result: QuoteResult | null }> }> {
    const feeTiers = [100, 500, 3000, 10000];   // 0.01%, 0.05%, 0.3%, 1%
    const results = await Promise.all(
      feeTiers.map(async (fee) => {
        try {
          const result = await this.quoteExactInputSingle({ ...params, fee });
          return { fee, result };
        } catch {
          return { fee, result: null };
        }
      })
    );

    const valid = results.filter(r => r.result !== null) as Array<{ fee: number; result: QuoteResult }>;
    if (valid.length === 0) {
      throw new Error(`No valid pool found for ${params.tokenIn} -> ${params.tokenOut}`);
    }

    const best = valid.reduce((a, b) => a.result.amountOut > b.result.amountOut ? a : b);
    return { best: best.result, bestFee: best.fee, all: results };
  }

  // @internal — kept for future use in quoteWithPriceImpact method
  // @ts-ignore — referenced by future quoteWithPriceImpact method
  private async _tokenDecimals(token: Address): Promise<number> {
    const cached = this._decimalsCache.get(token);
    if (cached) return cached;
    try {
      const result = await this.client.readContract({
        address: token,
        abi: [{ name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] }] as const,
        functionName: 'decimals',
      }) as number;
      this._decimalsCache.set(token, result);
      return result;
    } catch {
      this._decimalsCache.set(token, 18);
      return 18;
    }
  }
}

export function encodePath(tokens: Address[], fees: number[]): `0x${string}` {
  if (tokens.length !== fees.length + 1) {
    throw new Error('encodePath: tokens.length must equal fees.length + 1');
  }
  let hex = '';
  for (let i = 0; i < fees.length; i++) {
    hex += tokens[i].slice(2);
    hex += fees[i].toString(16).padStart(6, '0');
  }
  hex += tokens[tokens.length - 1].slice(2);
  return `0x${hex}` as `0x${string}`;
}

export const COMMON_TOKENS: Record<string, Record<string, Address>> = {
  ethereum: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    DAI:  '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  },
  arbitrum: {
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523FBab1',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    ARB:  '0x912CE59144191C1204E64559FE8253a0e49E6548',
  },
  base: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    cbBTC:'0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  },
  optimism: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  polygon: {
    WETH: '0x7ceB23FD6bC0adD59E62ac25578270cFf1b9f619',
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    WMATIC:'0x0d500B1d8E8Fb31bE9bE6f6bAFe8d0EC8d11a3b1',
  },
  bsc: {
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEbF2De08d9173bc095c',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
  },
};
