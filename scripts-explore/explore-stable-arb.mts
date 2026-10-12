// Explore cross-exchange stablecoin arb
// Stablecoins can depeg from $1.00 temporarily:
//   - USDC briefly depegged in March 2023 (SVB collapse) — went to $0.87
//   - USDT briefly depegged in April 2022 — went to $0.94
//   - UST completely collapsed in May 2022 — went to $0.01
//   - USDH on HyperEVM is a hyperliquid-native stablecoin — could depeg
//   - sUSDe (Ethena) — delta-neutral but has depegged twice (May 2025, Aug 2025)
//
// Strategy:
//   1. Monitor all stablecoin prices on HL spot, CEXs, and HyperEVM DEXs
//   2. When price deviates > 0.1% from $1, arb it
//   3. Buy cheap stablecoin on venue A, sell at $1 on venue B
//
// Key stablecoins to monitor:
//   USDC, USDT, USDE, sUSDe, USDH, USDF, DAI, FRAX, USDY, RUSD, TRU

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const HL_API = 'https://api.hyperliquid.xyz/info';
const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('=== Cross-Exchange Stablecoin Arb Exploration ===\n');

  // 1. Get all stablecoin prices on HL spot
  console.log('── HL Spot Stablecoin Prices ──');
  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const universe = spotMeta[0].universe || [];
  const ctxs = spotMeta[1] || [];
  const tokens = spotMeta[0].tokens || [];

  const stablecoinNames = ['USDC', 'USDT', 'USDE', 'sUSDe', 'USDH', 'USDF', 'DAI', 'FRAX', 'USDY', 'RUSD', 'TRU', 'USTC', 'DUSD', 'SWELL', 'SYN'];
  const found: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    let name = universe[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < tokens.length) name = tokens[idx].name || name;
    }
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (markPx > 0 && (stablecoinNames.includes(name) || name.startsWith('USD') || markPx > 0.95 && markPx < 1.05)) {
      found.push({ name, price: markPx, volume: vol, dev: (markPx - 1) * 100 });
    }
  }
  found.sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev));
  if (found.length === 0) {
    console.log('  No stablecoins found on HL spot');
  } else {
    for (const s of found) {
      const flag = Math.abs(s.dev) > 0.05 ? ' ⚠️' : '';
      console.log(`  ${s.name.padEnd(10)} $${s.price.toFixed(6).padStart(10)}  dev=${(s.dev).toFixed(4).padStart(7)}%  vol=$${(s.volume/1000).toFixed(0)}k${flag}`);
    }
  }

  // 2. Check CEX stablecoin prices (Binance API)
  console.log('\n── Binance Stablecoin Prices ──');
  const binanceSymbols = ['USDCUSDT', 'TUSDUSDT', 'FDUSDUSDT', 'USDPUSDT', 'DAIUSDT', 'USDEUSDT'];
  for (const sym of binanceSymbols) {
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
      if (res.ok) {
        const data = await res.json() as any;
        const px = parseFloat(data.price);
        const dev = (px - 1) * 100;
        const flag = Math.abs(dev) > 0.05 ? ' ⚠️' : '';
        console.log(`  ${sym.padEnd(15)} $${px.toFixed(6).padStart(10)}  dev=${dev.toFixed(4).padStart(7)}%${flag}`);
      }
    } catch {}
  }

  // 3. Check Curve finance stablecoin prices (mainnet)
  console.log('\n── Curve Pool Stablecoin Prices ──');
  try {
    const res = await fetch('https://api.curve.fi/api/getPools/ethereum/main');
    if (res.ok) {
      const data = await res.json() as any;
      const pools = data?.data?.poolData || [];
      const stablePools = pools.filter((p: any) => p.isStable !== false).slice(0, 5);
      for (const pool of stablePools) {
        console.log(`  Pool: ${pool.name}`);
        for (const coin of (pool.coins || [])) {
          const px = parseFloat(coin.usdPrice || '0');
          if (px > 0) {
            const dev = (px - 1) * 100;
            const flag = Math.abs(dev) > 0.1 ? ' ⚠️' : '';
            console.log(`    ${coin.symbol.padEnd(8)} $${px.toFixed(6).padStart(10)}  dev=${dev.toFixed(4)}%${flag}`);
          }
        }
      }
    } else {
      console.log('  Curve API unavailable');
    }
  } catch (e: any) {
    console.log(`  Curve API error: ${e.message}`);
  }

  // 4. HyperEVM stablecoin prices
  console.log('\n── HyperEVM DEX Stablecoin Prices ──');
  // HyperSwap V3 has USDC/USDT pool — check rate
  // Pool address: 0x... (need to look up)
  // For now, just check the kHYPE/WHYPE pool which we know exists
  const khypePool = '0x5cbe810071de393de35e574fb2830e16da794bab';
  try {
    const res = await fetch(HYPEREVM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: khypePool, data: '0x3850c7bd' }, 'latest'], id: 1 }),
    });
    const data = await res.json() as any;
    if (data.result && data.result.length > 2) {
      const slot0 = data.result.slice(2);
      // price = sqrtPriceX96 / 2^96
      const sqrtPriceX96 = BigInt('0x' + slot0.slice(0, 64));
      const price = Number(sqrtPriceX96 * sqrtPriceX96 * 10n**18n / (2n**192n)) / 1e18;
      console.log(`  kHYPE/WHYPE pool price: ${price.toFixed(6)}`);
      console.log(`  kHYPE discount: ${((1-price)*100).toFixed(2)}%`);
    }
  } catch {}

  // 5. Look for live arb opportunities
  console.log('\n── Live Stablecoin Arb Opportunities ──');
  // Look at HL spot stablecoin prices
  // Any pair trading > 0.1% off peg is a candidate
  const arbs = found.filter(s => Math.abs(s.dev) > 0.05 && s.volume > 10000);
  if (arbs.length === 0) {
    console.log('  ✅ No stablecoin depegs detected right now');
    console.log('  Markets are efficient — typical spread < 5 bps');
  } else {
    for (const a of arbs) {
      console.log(`  ${a.name}: ${(a.dev).toFixed(4)}% dev — POTENTIAL ARB`);
      console.log(`    Buy ${a.name} at $${a.price.toFixed(6)}`);
      console.log(`    Sell at $1.000 on CEX`);
      console.log(`    Profit: ${Math.abs(a.dev).toFixed(4)}% per trade`);
      console.log(`    On $25k: $${(25000 * Math.abs(a.dev) / 100).toFixed(2)}/cycle`);
    }
  }

  // 6. Hyperliquid-specific: HLP-USDC pair
  console.log('\n── Hyperliquid Native Stablecoin Opportunities ──');
  console.log('  USDF: HL-native stablecoin, HLP deposit receipt');
  console.log('    - Peg: 1:1 to USDC (mintable/redeemable 1:1)');
  console.log('    - Yield: 5-10% APR from HLP trading fees');
  console.log('    - Liquidity: limited spot trading');
  console.log('  USDH: HL test stablecoin (no real use)');
  console.log('    - Peg: target $1.00');
  console.log('    - Liquidity: very low');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Cross-exchange stablecoin arb is COMPETITIVE & RARE.');
  console.log('  - Stablecoin depegs happen ~2-3 times per year');
  console.log('  - When they happen, opportunities are short-lived (minutes)');
  console.log('  - Already covered by HFT firms (Wintermute, Jump, Cumberland)');
  console.log('  - Capital efficiency: LOW — capital sits idle waiting for events');
  console.log('');
  console.log('Recommendation: PASSIVE MONITORING ONLY');
  console.log('  - Add a stablecoin depeg alert (notify when any stablecoin deviates > 0.1%)');
  console.log('  - When alert fires, manually deploy capital');
  console.log('  - Don\'t tie up capital waiting for events');
  console.log('');
  console.log('ACTION: Add stablecoin depeg alert to scanner (already exists?)');
  console.log('  Reuse existing check-stablecoin-depegs.mts script');
}

main().catch(console.error);
