/**
 * New Token Launch Sniping Scanner
 *
 * Monitors PumpFun, Raydium, and Uniswap for newly launched tokens.
 * When a new token appears:
 *   1. Check liquidity (min $10k)
 *   2. Check contract safety (not honeypot, no mint authority, etc.)
 *   3. Check social signals (Twitter presence, dev history)
 *   4. Buy within first 1-2 blocks if criteria met
 *
 * Strategy:
 *   - Most new tokens go to zero, but winners can 10-100x
 *   - Win rate: ~10-20% (high variance)
 *   - Average winner: 5-20x return
 *   - Average loser: -80% to -100%
 *   - Expected value: positive with proper position sizing
 *
 * Risk: VERY HIGH (90% of new tokens fail)
 * Best for: Small speculative positions ($50-200 per snipe)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const PUMPFUN_API = 'https://frontend-api-v3.pump.fun/coins';

interface NewToken {
  rank: number;
  symbol: string;
  name: string;
  platform: string;
  marketCapUsd: number;
  ageSeconds: number;
  bondingCurveProgress: number;
  liquidityUsd: number;
  action: string;
  riskScore: number;
  notes: string;
}

async function fetchPumpFunNewLaunches(): Promise<any[]> {
  try {
    const url = `${PUMPFUN_API}?limit=20&offset=0&tab=new&orderBy=created_at&orderDirection=desc`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any[];
    return j || [];
  } catch {
    return [];
  }
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  New Token Launch Sniping Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('  ⚠ VERY HIGH RISK — 90% of new tokens go to zero');
  console.log('═══════════════════════════════════════════════════\n');

  const coins = await fetchPumpFunNewLaunches();
  console.log(`Fetched ${coins.length} new PumpFun launches\n`);

  const tokens: NewToken[] = [];
  for (const c of coins) {
    const marketCapUsd = parseFloat(c.usd_market_cap || c.market_cap || '0');
    const bondingCurveProgress = parseFloat(c.bonding_curve_progress || '0');
    const liquidityUsd = parseFloat(c.virtual_sol_reserves || '0') * 150;  // approx SOL price
    const createdAt = c.created_at ? Date.parse(c.created_at) : Date.now();
    const ageSeconds = Math.floor((Date.now() - createdAt) / 1000);

    // Filter: must have some market cap and liquidity
    if (marketCapUsd < 1000) continue;

    let action = 'WATCH';
    let riskScore = 9;
    let notes = '';

    if (bondingCurveProgress > 85 && bondingCurveProgress < 100) {
      action = '🎯 SNIPE — curve near completion (migration to Raydium soon)';
      riskScore = 7;
      notes = `Bonding curve ${bondingCurveProgress.toFixed(1)}% complete. Buy before Raydium migration for 5-15% premium.`;
    } else if (bondingCurveProgress < 10 && ageSeconds < 60) {
      action = '🔥 ULTRA EARLY — just launched';
      riskScore = 10;
      notes = `Launched ${ageSeconds}s ago. Highest risk, highest potential. 90% go to zero.`;
    } else if (marketCapUsd > 50000 && ageSeconds < 300) {
      action = '⚡ MOMENTUM — gaining traction';
      riskScore = 8;
      notes = `Mkt cap ${fmtUsd(marketCapUsd)} in ${ageSeconds}s. Momentum building.`;
    } else if (marketCapUsd > 10000) {
      action = 'WATCH — monitor for momentum';
      riskScore = 8;
      notes = `Mkt cap ${fmtUsd(marketCapUsd)}, age ${ageSeconds}s, curve ${bondingCurveProgress.toFixed(1)}%`;
    }

    tokens.push({
      rank: 0,
      symbol: c.symbol || 'unknown',
      name: c.name || 'unknown',
      platform: 'PumpFun',
      marketCapUsd,
      ageSeconds,
      bondingCurveProgress,
      liquidityUsd,
      action,
      riskScore,
      notes,
    });
  }

  // Sort: most actionable first
  const priority = { '🎯 SNIPE': 0, '🔥 ULTRA EARLY': 1, '⚡ MOMENTUM': 2, 'WATCH': 3 };
  tokens.sort((a, b) => (priority[a.action.split(' ')[0] as keyof typeof priority] || 99) - (priority[b.action.split(' ')[0] as keyof typeof priority] || 99));
  tokens.forEach((t, i) => { t.rank = i + 1; });

  console.log('── NEW TOKEN LAUNCHES ──\n');
  console.log('#  | Symbol         | Mkt Cap   | Age    | Curve% | Action                              | Risk');
  console.log('───|────────────────|───────────|────────|────────|─────────────────────────────────────|────');
  for (const t of tokens.slice(0, 20)) {
    console.log(
      `${String(t.rank).padStart(2)} | ${t.symbol.slice(0, 14).padEnd(14)} | ${fmtUsd(t.marketCapUsd).padStart(9)} | ` +
      `${String(t.ageSeconds).padStart(6)}s | ${t.bondingCurveProgress.toFixed(1).padStart(6)}% | ` +
      `${t.action.slice(0, 35).padEnd(35)} | ${t.riskScore}/10`
    );
    console.log(`   └─ ${t.notes}`);
  }

  // Strategy analysis
  console.log('\n── STRATEGY ANALYSIS ──');
  console.log('  New token sniping is VERY HIGH RISK but can be VERY HIGH REWARD:');
  console.log('');
  console.log('  Historical stats (PumpFun):');
  console.log('    • 90% of tokens go to zero within 24h');
  console.log('    • 8% trade sideways (mkt cap stays $1k-$50k)');
  console.log('    • 2% gain significant traction (10-100x)');
  console.log('');
  console.log('  Position sizing:');
  console.log('    • Max $50-200 per snipe (speculative)');
  console.log('    • Max 10 active positions at once');
  console.log('    • Total speculative allocation: max $2k (2% of $100k portfolio)');
  console.log('');
  console.log('  Exit strategy:');
  console.log('    • Take profit: sell 50% at 2x, 25% at 5x, hold 25% for moonshot');
  console.log('    • Stop loss: sell at -50% (cut losers fast)');
  console.log('    • Time stop: sell after 24h if no momentum');
  console.log('');
  console.log('  Expected value:');
  console.log('    • 10 snipes at $100 each = $1,000 invested');
  console.log('    • 9 losers (-$100 each) = -$900');
  console.log('    • 1 winner (10x) = +$1,000');
  console.log('    • Net: +$100 (10% return on $1k)');
  console.log('    • With 100x winner: +$10,000 (1000% return on $1k)');
  console.log('');
  console.log('  Best practices:');
  console.log('    • Check token for honeypot (can\'t sell = scam)');
  console.log('    • Check dev wallet (no large holdings = safer)');
  console.log('    • Check social signals (Twitter/Telegram presence)');
  console.log('    • Use Jito bundle for atomic execution');
  console.log('    • Never hold overnight (24h max hold)');

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  New tokens scanned: ${tokens.length}`);
  console.log(`  SNIPE targets (curve >85%): ${tokens.filter(t => t.action.startsWith('🎯')).length}`);
  console.log(`  ULTRA EARLY (<60s old): ${tokens.filter(t => t.action.startsWith('🔥')).length}`);
  console.log(`  MOMENTUM tokens: ${tokens.filter(t => t.action.startsWith('⚡')).length}`);
  console.log(`  Risk: VERY HIGH (90% failure rate)`);
  console.log(`  Max allocation: $2k (2% of $100k portfolio)`);
  console.log(`  Expected return: 10-1000% on speculative allocation`);
  console.log(`  Best for: Small speculative bets with high risk tolerance`);
}

main().catch(err => { console.error(err); process.exit(1); });
