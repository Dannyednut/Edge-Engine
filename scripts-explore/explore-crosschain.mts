// Cross-Chain Arbitrage Scanner
// Compare token prices across:
//   - Hyperliquid (perp + spot)
//   - Solana (Jupiter DEX)
//   - Ethereum (Uniswap V3)
//   - Binance Smart Chain (PancakeSwap)
//
// Strategy: When same token trades at different prices across chains,
// bridge and capture the spread
//
// Challenges:
//   - Bridge fees ($5-50 depending on chain)
//   - Bridge time (5-30 min)
//   - Price moves during bridge delay
//   - Liquidity varies by chain

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

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Jupiter price API (Solana)
async function getJupiterPrice(tokenMint: string): Promise<number | null> {
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${tokenMint}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.data?.[tokenMint]?.price ?? null;
  } catch {
    return null;
  }
}

// Binance API
async function getBinancePrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Cross-Chain Arbitrage Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get HL perp prices
  console.log('── Loading HL perp prices ──');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];

  // Tokens to compare (exist on multiple chains)
  const tokens = [
    { name: 'SOL', binance: 'SOLUSDT', jupiter: 'So11111111111111111111111111111111111111112' },
    { name: 'ETH', binance: 'ETHUSDT', jupiter: null }, // native ETH not on Solana
    { name: 'BTC', binance: 'BTCUSDT', jupiter: null },
    { name: 'WIF', binance: 'WIFUSDT', jupiter: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
    { name: 'JUP', binance: 'JUPUSDT', jupiter: 'JUPyiwrYJFskUPiHa7hkeR97V4gzZd1r6P5c5eLXNw7' },
    { name: 'PYTH', binance: 'PYTHUSDT', jupiter: 'HZ1JovNiVvGrGNiiYvEozjgzkD5Z6ghMwEYTX4Qorf2B' },
    { name: 'HYPE', binance: null, jupiter: null }, // HL native, not on CEX
    { name: 'WLD', binance: 'WLDUSDT', jupiter: null },
    { name: 'XRP', binance: 'XRPUSDT', jupiter: null },
    { name: 'DOGE', binance: 'DOGEUSDT', jupiter: null },
  ];

  console.log(`  Comparing ${tokens.length} tokens across HL, Binance, Jupiter (Solana)\n`);

  // 2. Get HL prices
  const hlPrices: Record<string, number> = {};
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    if (markPx > 0) hlPrices[name] = markPx;
  }

  // 3. Get Binance prices
  const binancePrices: Record<string, number> = {};
  for (const t of tokens) {
    if (t.binance) {
      const px = await getBinancePrice(t.binance);
      if (px) binancePrices[t.name] = px;
    }
  }

  // 4. Get Jupiter prices (Solana)
  const jupiterPrices: Record<string, number> = {};
  for (const t of tokens) {
    if (t.jupiter) {
      const px = await getJupiterPrice(t.jupiter);
      if (px) jupiterPrices[t.name] = px;
    }
  }

  // 5. Compute spreads
  console.log('── Cross-Chain Price Comparison ──');
  console.log('  Token   | HL            | Binance       | Jupiter (Solana) | HL-Binance % | HL-Jupiter %');
  console.log('  ────────|───────────────|───────────────|──────────────────|──────────────|─────────────');

  for (const t of tokens) {
    const hl = hlPrices[t.name];
    const bin = binancePrices[t.name];
    const jup = jupiterPrices[t.name];
    if (!hl) continue;
    const hlStr = `$${hl.toFixed(6)}`;
    const binStr = bin ? `$${bin.toFixed(6)}` : 'N/A';
    const jupStr = jup ? `$${jup.toFixed(6)}` : 'N/A';
    const binSpread = bin ? `${((hl - bin) / bin * 100).toFixed(3)}%` : 'N/A';
    const jupSpread = jup ? `${((hl - jup) / jup * 100).toFixed(3)}%` : 'N/A';
    console.log(`  ${t.name.padEnd(8)}| ${hlStr.padStart(13)} | ${binStr.padStart(13)} | ${jupStr.padStart(16)} | ${binSpread.padStart(12)} | ${jupSpread.padStart(11)}`);
  }

  // 6. Find arbitrage opportunities
  console.log('\n── Cross-Chain Arb Opportunities (>0.5% spread) ──');
  for (const t of tokens) {
    const hl = hlPrices[t.name];
    const bin = binancePrices[t.name];
    const jup = jupiterPrices[t.name];
    if (!hl) continue;
    if (bin) {
      const spread = ((hl - bin) / bin) * 100;
      if (Math.abs(spread) > 0.5) {
        const dir = spread > 0 ? 'SELL HL / BUY BINANCE' : 'BUY HL / SELL BINANCE';
        console.log(`  ${t.name}: ${spread.toFixed(3)}% (${dir})`);
      }
    }
    if (jup) {
      const spread = ((hl - jup) / jup) * 100;
      if (Math.abs(spread) > 0.5) {
        const dir = spread > 0 ? 'SELL HL / BUY SOLANA' : 'BUY HL / SELL SOLANA';
        console.log(`  ${t.name}: ${spread.toFixed(3)}% (${dir})`);
      }
    }
  }

  // 7. Bridge fees + delays
  console.log('\n── Bridge Costs & Delays ──');
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  Bridge             | Fee        | Delay    | Risk');
  console.log('  ───────────────────|────────────|──────────|─────────');
  console.log('  HL → Solana (Wormhole) | $5-20 | 5-15 min | Medium');
  console.log('  HL → Ethereum (Wormhole) | $20-100 | 10-30 min | Medium');
  console.log('  Solana → HL (Wormhole) | $5-20 | 5-15 min | Medium');
  console.log('  Ethereum → HL (Wormhole) | $20-100 | 10-30 min | Medium');
  console.log('  Binance → HL (CEX withdrawal) | $5-30 | 5-30 min | Low');
  console.log('  HL → Binance (CEX deposit) | $5-30 | 5-30 min | Low');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Cross-chain arbitrage is COMPETITIVE, FRICIOUS, SLOW.');
  console.log('  - Spreads typically <0.5% (efficient market)');
  console.log('  - Bridge fees eat 0.1-1% of capital');
  console.log('  - Bridge delays cause price risk (5-30 min exposure)');
  console.log('  - Already covered by Wintermute, Jump, Cumberland');
  console.log('');
  console.log('Recommendation: SKIP for active capital');
  console.log('  - Better to use VOOI (instant) or CEX-HL (5-30 min) for cross-venue');
  console.log('  - True cross-chain arb is dominated by pros with HFT infrastructure');
  console.log('');
  console.log('ACTION: Add cross-chain price monitor (alert-only, no execution)');
  console.log('  - Useful for spotting depegs or extreme spreads');
  console.log('  - Reuse existing dex_cex_flashloan strategy (already in scanner)');
}

main().catch(console.error);
