/**
 * HL DeFi Yield Dashboard — monitors all Hyperliquid DeFi yields in one place.
 *
 * Pulls:
 *   1. HyperLend lending rates (19 markets)
 *   2. Pendle V2 kHYPE/stHYPE/beHYPE fixed + floating yields
 *   3. HyperSwap V3 pool prices (27 pools) for AMM vs orderbook comparison
 *   4. kHYPE/WHYPE LST discount
 *   5. HL orderbook spot prices for all tradeable tokens
 *
 * Outputs a single dashboard report showing all yields + arb spreads.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

// Load .env
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
const PENDLE_API = 'https://api-v2.pendle.finance/core/v2';
const HL_API = 'https://api.hyperliquid.xyz/info';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL DeFi Yield Dashboard');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. HL orderbook prices
  console.log('── HL Orderbook Spot Prices ──────────────────');
  const hlPrices = await getHlPrices();
  for (const [name, price] of hlPrices) {
    if (price > 0) console.log(`  ${name.padEnd(15)} $${price.toFixed(4)}`);
  }

  // 2. HyperSwap V3 kHYPE/WHYPE price
  console.log('\n── HyperSwap V3 kHYPE/WHYPE ──────────────────');
  const khypePrice = await getV3Price('0x5cbe810071de393de35e574fb2830e16da794bab');
  const discount = (1 - khypePrice) * 100;
  console.log(`  kHYPE/WHYPE price: ${khypePrice.toFixed(6)}`);
  console.log(`  kHYPE discount: ${discount.toFixed(2)}%`);
  console.log(`  Arb profit (after fees): ${(discount - 0.05).toFixed(2)}% on $5k = $${((discount - 0.05) / 100 * 5000).toFixed(2)}`);

  // 3. Pendle kHYPE + stHYPE yields
  console.log('\n── Pendle V2 LST Yields (chain 999) ──────────');
  const pendleMarkets = await getPendleHlMarkets();
  for (const m of pendleMarkets) {
    const underAPY = (m.details.underlyingApy * 100).toFixed(2);
    const impliedAPY = (m.details.impliedApy * 100).toFixed(2);
    const tvl = (m.details.totalTvl / 1e6).toFixed(1);
    console.log(`  ${m.name.padEnd(15)} under=${underAPY}%  implied=${impliedAPY}%  TVL=$${tvl}M  expiry=${m.expiry?.slice(0,10)}`);
  }

  // 4. HyperLend lending rates
  console.log('\n── HyperLend Lending Rates ──────────────────');
  const hlendRates = await getHyperLendRates();
  for (const [addr, rates] of hlendRates) {
    const supply = (rates.supplyAPR * 100).toFixed(2);
    const borrow = (rates.borrowAPR * 100).toFixed(2);
    if (parseFloat(supply) > 0.01) {
      console.log(`  ${addr.slice(0,10)}...  supply=${supply}%  borrow=${borrow}%`);
    }
  }

  // 5. Summary
  console.log('\n── ARB SUMMARY ──────────────────────────────');
  console.log(`  kHYPE LST carry arb: ${discount.toFixed(2)}% discount + 2.19% yield = ~${((discount + 2.19) * 365/8).toFixed(0)}% APR`);
  console.log(`  Profit per $5k per 8-day cycle: $${((discount - 0.05) / 100 * 5000).toFixed(2)}`);
  console.log('');
}

async function getHlPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  try {
    const res = await fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }),
    });
    const data = await res.json() as any[];
    const universe = data[0].universe || [];
    const ctxs = data[1] || [];
    const tokens = data[0].tokens || [];
    for (let i = 0; i < universe.length; i++) {
      let name = universe[i].name || '';
      const markPx = parseFloat(ctxs[i]?.markPx || '0');
      const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
      if (markPx > 0 && vol > 10000) {
        if (name.startsWith('@')) {
          const idx = parseInt(name.slice(1));
          if (idx < tokens.length) name = tokens[idx].name || name;
        }
        prices.set(name, markPx);
      }
    }
  } catch {}
  return prices;
}

async function getV3Price(poolAddress: string): Promise<number> {
  try {
    const res = await fetch(HYPEREVM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: poolAddress, data: '0x3850c7bd' }, 'latest'], id: 1 }),
    });
    const json = await res.json() as { result?: string };
    const result = json.result || '0x';
    if (result.length < 66) return 0;
    const sqrtPriceX96 = BigInt('0x' + result.slice(2, 66));
    const sqrtPrice = Number(sqrtPriceX96) / Math.pow(2, 96);
    return sqrtPrice * sqrtPrice; // Both 18 decimals → no adjustment needed
  } catch { return 0; }
}

async function getPendleHlMarkets(): Promise<any[]> {
  const markets: any[] = [];
  for (let skip = 0; skip < 800; skip += 100) {
    try {
      const res = await fetch(`${PENDLE_API}/markets/all?limit=100&skip=${skip}`);
      const json = await res.json() as { results?: any[] };
      const results = json.results ?? [];
      if (results.length === 0) break;
      for (const m of results) {
        if (m.chainId === 999 && (m.name.includes('HYPE') || m.name.includes('kHYPE') || m.name.includes('stHYPE'))) {
          markets.push(m);
        }
      }
    } catch { break; }
  }
  return markets;
}

async function getHyperLendRates(): Promise<Map<string, { supplyAPR: number; borrowAPR: number }>> {
  const rates = new Map<string, { supplyAPR: number; borrowAPR: number }>();
  try {
    const res = await fetch('https://api.hyperlend.finance/data/markets/rates');
    const json = await res.json() as Record<string, { supplyAPR: number; borrowAPR: number }>;
    for (const [addr, r] of Object.entries(json)) {
      if (typeof r.supplyAPR === 'number') rates.set(addr, r);
    }
  } catch {}
  return rates;
}

main().catch(e => { console.error(e); process.exit(1); });
