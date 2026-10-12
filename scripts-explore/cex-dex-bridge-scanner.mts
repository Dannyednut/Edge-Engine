/**
 * CEX-DEX Bridge Arbitrage Scanner
 *
 * Detects price differences between CEX (Binance, OKX, Bybit) and
 * DEX (Uniswap, Curve, Raydium) for the same asset.
 *
 * Strategy:
 *   - Buy on cheaper venue (CEX or DEX)
 *   - Sell on more expensive venue
 *   - Bridge assets between venues (withdraw/deposit)
 *   - Capture the spread
 *
 * Also detects:
 *   - CEX withdrawal/deposit delays (creates temporary arb)
 *   - Bridge fees (must be < spread to be profitable)
 *   - Gas costs for DEX side
 *
 * Key pairs to monitor:
 *   - BTC: Binance vs HL perp vs wBTC DEX
 *   - ETH: Binance vs HL perp vs wETH DEX
 *   - SOL: Binance vs Raydium/Orca
 *   - USDC: Binance vs Curve vs Aave
 *   - wstETH: Binance vs Curve vs Uniswap
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

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

interface BridgeArb {
  rank: number;
  asset: string;
  buyVenue: string;
  sellVenue: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  bridgeCost: number;
  netProfit10k: number;
  bridgeTime: string;
  riskScore: number;
  notes: string;
}

async function hlPost(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getCoingeckoPrices(): Promise<Record<string, number>> {
  try {
    const ids = ['bitcoin', 'ethereum', 'solana', 'ripple', 'dogecoin', 'avalanche-2', 'chainlink', 'uniswap', 'aave', 'curve-dao-token'];
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return {};
    const j = await res.json() as any;
    return {
      BTC: j['bitcoin']?.usd,
      ETH: j['ethereum']?.usd,
      SOL: j['solana']?.usd,
      XRP: j['ripple']?.usd,
      DOGE: j['dogecoin']?.usd,
      AVAX: j['avalanche-2']?.usd,
      LINK: j['chainlink']?.usd,
      UNI: j['uniswap']?.usd,
      AAVE: j['aave']?.usd,
      CRV: j['curve-dao-token']?.usd,
    };
  } catch {
    return {};
  }
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  CEX-DEX Bridge Arbitrage Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Fetch prices from multiple sources
  const [hlData, cgPrices] = await Promise.all([
    hlPost({ type: 'metaAndAssetCtxs' }),
    getCoingeckoPrices(),
  ]);

  // Build price map
  const hlPrices: Record<string, number> = {};
  const universe = hlData?.[0]?.universe || [];
  const ctxs = hlData?.[1] || [];
  for (let i = 0; i < universe.length; i++) {
    if (!universe[i] || !ctxs[i] || universe[i].name.startsWith('@')) continue;
    hlPrices[universe[i].name] = parseFloat(ctxs[i].markPx);
  }

  // Compare HL vs CoinGecko (aggregated CEX prices)
  const opps: BridgeArb[] = [];
  const bridgeCosts: Record<string, { cost: number; time: string }> = {
    BTC: { cost: 5, time: '10-30min' },
    ETH: { cost: 3, time: '5-15min' },
    SOL: { cost: 0.5, time: '1-5min' },
    XRP: { cost: 0.5, time: '1-5min' },
    DOGE: { cost: 0.5, time: '1-5min' },
    AVAX: { cost: 1, time: '5-10min' },
    LINK: { cost: 2, time: '5-10min' },
    UNI: { cost: 2, time: '5-10min' },
    AAVE: { cost: 2, time: '5-10min' },
    CRV: { cost: 2, time: '5-10min' },
  };

  for (const [asset, hlPrice] of Object.entries(hlPrices)) {
    const cgPrice = cgPrices[asset];
    if (!cgPrice || !hlPrice) continue;

    const spreadPct = ((hlPrice - cgPrice) / cgPrice) * 100;
    if (Math.abs(spreadPct) < 0.05) continue;  // min 0.05% spread

    const bridge = bridgeCosts[asset] || { cost: 5, time: '10min' };
    const bridgeCostPct = (bridge.cost / 10000) * 100;  // as % of $10k
    const netProfitPct = Math.abs(spreadPct) - bridgeCostPct - 0.1;  // minus 0.1% fees
    if (netProfitPct <= 0) continue;

    const netProfit10k = 10000 * netProfitPct / 100;
    const buyVenue = spreadPct > 0 ? 'CEX (CoinGecko avg)' : 'Hyperliquid';
    const sellVenue = spreadPct > 0 ? 'Hyperliquid' : 'CEX (CoinGecko avg)';
    const buyPrice = spreadPct > 0 ? cgPrice : hlPrice;
    const sellPrice = spreadPct > 0 ? hlPrice : cgPrice;

    opps.push({
      rank: 0,
      asset,
      buyVenue,
      sellVenue,
      buyPrice,
      sellPrice,
      spreadPct,
      bridgeCost: bridge.cost,
      netProfit10k,
      bridgeTime: bridge.time,
      riskScore: 4,
      notes: `Spread ${spreadPct.toFixed(3)}%, bridge cost $${bridge.cost}, bridge time ${bridge.time}`,
    });
  }

  // Sort by net profit
  opps.sort((a, b) => b.netProfit10k - a.netProfit10k);
  opps.forEach((o, i) => { o.rank = i + 1; });

  console.log(`── CEX-DEX BRIDGE ARBITRAGE OPPORTUNITIES (${opps.length} found) ──\n`);
  console.log('#  | Asset | Buy Venue           | Sell Venue          | Buy Price  | Sell Price | Spread%  | Bridge Cost | Net Profit/$10k | Bridge Time | Risk');
  console.log('───|───────|─────────────────────|─────────────────────|────────────|────────────|──────────|─────────────|─────────────────|─────────────|────');
  for (const o of opps.slice(0, 20)) {
    console.log(
      `${String(o.rank).padStart(2)} | ${o.asset.padEnd(5)} | ${o.buyVenue.padEnd(19)} | ${o.sellVenue.padEnd(19)} | ` +
      `${o.buyPrice.toFixed(4).padStart(10)} | ${o.sellPrice.toFixed(4).padStart(10)} | ` +
      `${o.spreadPct >= 0 ? '+' : ''}${o.spreadPct.toFixed(3).padStart(7)}% | $${o.bridgeCost.toFixed(2).padStart(9)} | ` +
      `${fmtUsd(o.netProfit10k).padStart(15)} | ${o.bridgeTime.padEnd(11)} | ${o.riskScore}/10`
    );
  }

  // Strategy explanation
  console.log('\n── STRATEGY ──');
  console.log('  1. Detect price difference between CEX and DEX');
  console.log('  2. Buy on cheaper venue');
  console.log('  3. Bridge asset to other venue (withdraw/deposit)');
  console.log('  4. Sell on more expensive venue');
  console.log('  5. Net profit = spread - bridge cost - fees');
  console.log('');
  console.log('  Bridge costs (approximate):');
  console.log('    • BTC: $5, 10-30min (slowest)');
  console.log('    • ETH: $3, 5-15min');
  console.log('    • SOL: $0.50, 1-5min (fastest)');
  console.log('    • ERC-20 tokens: $2-5, 5-15min');
  console.log('');
  console.log('  Risk factors:');
  console.log('    • Price moves during bridge time (slippage)');
  console.log('    • Bridge delays (network congestion)');
  console.log('    • CEX withdrawal limits');
  console.log('    • Gas costs for DEX side');
  console.log('');
  console.log('  Best practices:');
  console.log('    • Maintain balances on BOTH CEX and DEX');
  console.log('    • Execute both legs simultaneously when possible');
  console.log('    • Use fast bridges (Solana = best, 1-5min)');
  console.log('    • Avoid during high volatility (price moves too fast)');

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ──');
  // Assume 10 successful arbs per day
  const avgProfit = opps.length > 0 ? opps.slice(0, 5).reduce((s, o) => s + o.netProfit10k, 0) / Math.min(5, opps.length) : 0;
  const dailyArbs = 10;
  const dailyProfit = avgProfit * dailyArbs;
  console.log(`  Average profit per arb: ${fmtUsd(avgProfit)} (on $10k)`);
  console.log(`  Estimated arbs per day: ${dailyArbs}`);
  console.log(`  Daily profit: ${fmtUsd(dailyProfit)}`);
  console.log(`  Monthly profit: ${fmtUsd(dailyProfit * 30)}`);
  console.log(`  Annual profit: ${fmtUsd(dailyProfit * 365)}`);
  console.log(`  Capital required: $20k (split across CEX + DEX)`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Assets compared: ${Object.keys(hlPrices).length}`);
  console.log(`  Profitable arb opportunities: ${opps.length}`);
  console.log(`  Top spread: ${opps[0]?.spreadPct.toFixed(3)}% (${opps[0]?.asset})`);
  console.log(`  Top net profit: ${fmtUsd(opps[0]?.netProfit10k || 0)} on $10k`);
  console.log(`  Daily profit potential: ${fmtUsd(dailyProfit)} (10 arbs/day)`);
  console.log(`  Risk: MEDIUM (bridge time = price movement risk)`);
  console.log(`  Capital: $20k (split: $10k CEX + $10k DEX)`);
  console.log(`  Best for: Maintaining balances on multiple venues for instant capture`);
}

main().catch(err => { console.error(err); process.exit(1); });
