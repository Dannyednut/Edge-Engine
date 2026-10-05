/**
 * Hyperliquid DeFi Contract Registry
 *
 * Verified live Oct 8 2026 via HyperEVM RPC (chain ID 999).
 * Addresses provided by principal + verified by calling factory.getPair().
 */

// ─── HyperEVM RPC ──────────────────────────────────────────────────────
export const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
export const HYPEREVM_CHAIN_ID = 999;

// ─── HyperSwap V2 (Uniswap V2 fork) ───────────────────────────────────
export const HYPERSWAP_V2_FACTORY = '0x724412C00059bf7d6ee7d4a1d0D5cd4de3ea1C48' as const;
export const HYPERSWAP_V2_ROUTER  = '0xb4a9C4e6Ea8E2191d2FA5B380452a634Fb21240A' as const;

// ─── HyperSwap V3 (concentrated liquidity) ────────────────────────────
export const HYPERSWAP_V3_FACTORY       = '0xB1c0fa0B789320044A6F623cFe5eBda9562602E3' as const;
export const HYPERSWAP_V3_SWAP_ROUTER_01 = '0x4E2960a8cd19B467b82d26D83fAcb0fAE26b094D' as const;
export const HYPERSWAP_V3_SWAP_ROUTER_02 = '0x6D99e7f6747AF2cDbB5164b6DD50e40D4fDe1e77' as const;
export const HYPERSWAP_UNIVERSAL_ROUTER  = '0xefAbEB7A19bB848b359e5dd5a63b1a634AAfD229' as const;

// ─── HyperLend (Aave V3 fork — supports flashloans) ───────────────────
export const HYPERLEND_POOL = '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b' as const;
export const HYPERLEND_FLASHLOAN_FEE = 0.0004;  // 0.04%

// ─── Token addresses on HyperEVM ──────────────────────────────────────
export const HL_TOKENS = {
  WHYPE:  '0x5555555555555555555555555555555555555555' as const,  // Wrapped HYPE (native gas token)
  wstHYPE:'0x94e8396e0869c9F2200760aF0621aFd240E1CF38' as const,
  kHYPE:  '0xfD739d4e423301CE9385c1fb8850539D657C296D' as const,  // Kinetiq liquid staked HYPE
  beHYPE: '0xd8FC8F0b03eBA61F64D08B0bef69d80916E5DdA9' as const,
  UBTC:   '0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463' as const,  // Wrapped BTC
  UETH:   '0xBe6727B535545C67d5cAa73dEa54865B92CF7907' as const,  // Wrapped ETH
  USOL:   '0x068f321Fa8Fb9f0D135f290Ef6a3e2813e1c8A29' as const,  // Wrapped SOL
  USDC:   '0xb88339CB7199b77E23DB6E890353E22632Ba630f' as const,
  USDT0:  '0xb8CE59FC3717ada4C02eaDF9682A9e934F625ebb' as const,
  USDe:   '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34' as const,
  USDHL:  '0xb50A96253aBDF803D85efcDce07Ad8becBc52BD5' as const,
  USR:    '0x0aD339d66BF4AeD5ce31c64Bc37B3244b6394A77' as const,
  USDH:   '0x111111a1a0667d36bD57c0A9f569b98057111111' as const,
} as const;

// ─── HyperSwap V2 Pools (verified via factory.getPair) ────────────────
export const HYPERSWAP_V2_POOLS: Record<string, string> = {
  'WHYPE/USDC':  '0x3212945caaeeb8b9294fff87b191f8df7c7e8641',
  'WHYPE/USDT0': '0x313ced5da609d678d945c19091baaf3a022537a1',
  'WHYPE/UBTC':  '0xe6111ad7589e41b71d8b530957cb4b2c0069f615',
  'WHYPE/UETH':  '0x8119c0b6dc9c521386b03d77c691479cf101f8f4',
  'WHYPE/kHYPE': '0x9053c66a3e4d4da6de2c46692cfa88a43d8445ab',
  'WHYPE/USDe':  '0x60d2d482981aa9aca5fd44f84a6ef4a74cb3f1a6',
  'USDC/USDT0':  '0x629e865943d87dc456a892449950c3c4d135b1bd',
  'USDC/UETH':   '0x5c05c3c616fb70320c23a0865775b85e0a81f25a',
  'USDT0/UBTC':  '0x69ae6b6c9694a82c804e233e288c9e695c6eb22f',
  'USDT0/UETH':  '0xc83f21637e4e4e5dc22aecbfd1392cfa2178fa1d',
  'USDT0/kHYPE': '0x747df2559f98060c0f01acd882d29afce3508c8a',
  'USDT0/USDe':  '0x712898ffbc8840a8edae33e70c6f837759914fce',
  'UBTC/UETH':   '0x0cc106014631d83df77354d9cd51598cd8d21cd5',
  'UBTC/USDe':   '0xdadcb98acee1b1aa2791952e73b25962d34b6f0d',
  'UETH/USDe':   '0x58e470bed2b55c9d2962347f3756224f0fa4e773',
};

// ─── Token decimals ────────────────────────────────────────────────────
export const HL_TOKEN_DECIMALS: Record<string, number> = {
  WHYPE:  18,
  wstHYPE: 18,
  kHYPE:  18,
  beHYPE: 18,
  UBTC:   8,
  UETH:   18,
  USOL:   9,
  USDC:   6,
  USDT0:  6,
  USDe:   18,
  USDHL:  6,
  USR:    18,
  USDH:   18,
};

// ─── HyperSwap V3 Pools (verified via V3 Factory getPool) ─────────────
export const HYPERSWAP_V3_POOLS: Array<{ pair: string; fee: number; address: string }> = [
  { pair: 'WHYPE/USDC',  fee: 500,   address: '0x264a1f3b9eb574a3e7be869ac415dc5430dcf571' },
  { pair: 'WHYPE/USDC',  fee: 3000,  address: '0xe712d505572b3f84c1b4deb99e1beab9dd0e23c9' },
  { pair: 'WHYPE/USDT0', fee: 100,   address: '0x7f63ac9b82905d870071024fa310cf0ab8a74ad1' },
  { pair: 'WHYPE/USDT0', fee: 500,   address: '0x337b56d87a6185cd46af3ac2cdf03cbc37070c30' },
  { pair: 'WHYPE/USDT0', fee: 3000,  address: '0x56abfaf40f5b7464e9cc8cff1af13863d6914508' },
  { pair: 'WHYPE/USDT0', fee: 10000, address: '0xf40d57783c3359f160d006b9bc7a2e4311fe6a86' },
  { pair: 'WHYPE/UETH',  fee: 100,   address: '0xa8defb49f8461d71f0dc35e2c0144dc781b4f561' },
  { pair: 'WHYPE/UETH',  fee: 500,   address: '0x259232456df1520db37231a82e9c7c901ffedb35' },
  { pair: 'WHYPE/UETH',  fee: 3000,  address: '0x719d7f4388cb0efb6a48f3c3266e443edce6588a' },
  { pair: 'WHYPE/UETH',  fee: 10000, address: '0x9f5d0f0dd733e60b6ff2425e3f3e632cbad0a81f' },
  { pair: 'WHYPE/UBTC',  fee: 100,   address: '0xd41b6a5ae88dccb54a58fce3d4a11cd3d6d707b0' },
  { pair: 'WHYPE/UBTC',  fee: 500,   address: '0xbbcf8523811060e1c112a8459284a48a4b17661f' },
  { pair: 'WHYPE/UBTC',  fee: 3000,  address: '0x3a36b04bcc1d5e2e303981ef643d2668e00b43e7' },
  { pair: 'WHYPE/UBTC',  fee: 10000, address: '0xb2eb6d459759936160a57297e4a03e067dbbe5cb' },
  { pair: 'WHYPE/kHYPE', fee: 100,   address: '0x5cbe810071de393de35e574fb2830e16da794bab' },
  { pair: 'WHYPE/kHYPE', fee: 500,   address: '0x3fa4005668ae445e9cb88725fba8e8e88e508eb8' },
  { pair: 'WHYPE/kHYPE', fee: 3000,  address: '0xdf20a6a8a03ab178f7874303598bc0281eb13923' },
  { pair: 'WHYPE/kHYPE', fee: 10000, address: '0x332ec9391bd388d561ff8837427fc08794b7eb72' },
  { pair: 'WHYPE/USDe',  fee: 500,   address: '0x546c3c51bcac838bcff9b08f906ce39b7e8789c4' },
  { pair: 'WHYPE/USDe',  fee: 3000,  address: '0x1c501aff24ddef9abb58d4653f7bd41dbef68496' },
  { pair: 'WHYPE/USDe',  fee: 10000, address: '0xfeee52beb3f263a307fdf0881ab6aacbbe9bd10e' },
  { pair: 'USDC/USDT0',  fee: 100,   address: '0x55443b2a8ee28dc35172d9e7d8982b4282415356' },
  { pair: 'USDC/USDT0',  fee: 500,   address: '0xbb3f50de0be1b66851b33a8a133658a1cf6847a8' },
  { pair: 'UBTC/UETH',   fee: 100,   address: '0xea023b3e127af63f9bbea4e7908bfab7af7da2c2' },
  { pair: 'UBTC/UETH',   fee: 500,   address: '0x4430c117ee56e26863f9f0ae7c8e9bd36c9b623a' },
  { pair: 'UBTC/UETH',   fee: 3000,  address: '0x4c4ed89e17715bc4ebdcd2685f9152f8a0d8201e' },
  { pair: 'UBTC/UETH',   fee: 10000, address: '0x1dc45adcdff099f4d3d3c92f2b2e97ed15289c65' },
  { pair: 'UETH/USDe',   fee: 3000,  address: '0xd5d483ad52c20235f2fd2a64e6f00ea4cc90fdf4' },
];

// ─── V3 Pool helper: compute price from sqrtPriceX96 ──────────────────
// price = (sqrtPriceX96 / 2^96)^2, adjusted for token decimals
export function v3PriceToHuman(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 === 0n) return 0;
  // Price of token0 in terms of token1 = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)
  const sqrtPrice = Number(sqrtPriceX96) / Math.pow(2, 96);
  const rawPrice = sqrtPrice * sqrtPrice;
  const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
  return rawPrice * decimalAdjustment;
}
