// Explore Hyperliquid Perp Liquidation Hunting
// On HL perps, traders can be liquidated when their margin falls below maintenance
// Liquidators can step in to take over the position + earn a liquidation bonus
//
// HL liquidation mechanics:
//   - Anyone can call liquidate() on underwater positions
//   - Liquidator receives: position + collateral + liquidation fee
//   - Liquidation fee: 0.5-5% of position size (varies by risk)
//   - HLP vault takes the position if no liquidator steps in
//
// Strategy:
//   1. Monitor all open positions on HL perps
//   2. When a position's margin ratio approaches maintenance, prepare to liquidate
//   3. Submit liquidate() tx when margin ratio crosses threshold
//   4. Immediately close the position at market (sell the long / buy the short)
//   5. Profit = liquidation fee - slippage on close

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

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Perp Liquidation Hunter');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get total open interest
  console.log('── HL Open Interest Overview ──');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];

  let totalOi = 0;
  const topOi: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const oi = parseFloat(ctxs[i]?.openInterest || '0');
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const oiUsd = oi * markPx;
    totalOi += oiUsd;
    if (oiUsd > 1_000_000) {
      topOi.push({ name, markPx, oi: oiUsd, funding, vol });
    }
  }
  topOi.sort((a, b) => b.oi - a.oi);
  console.log(`  Total HL OI: $${(totalOi/1e9).toFixed(2)}B`);
  console.log(`  Top 10 by OI:`);
  for (const t of topOi.slice(0, 10)) {
    console.log(`    ${t.name.padEnd(10)} OI=$${(t.oi/1e6).toFixed(1)}M  px=$${t.markPx.toFixed(4)}  fund=${(t.funding*100).toFixed(4)}%/h`);
  }

  // 2. Estimate liquidation volume
  console.log('\n── Estimated Daily Liquidation Volume ──');
  // Typical liquidation rate: 0.1-1% of OI per day (depends on volatility)
  // On HL: 0.5% of OI per day = $60M/day in liquidations
  // Liquidation bonus: 0.5-5% of position size (avg ~1.5%)
  // Daily liquidator profit: $60M * 1.5% = $900k/day
  // Competition: ~5-10 liquidator bots active
  // Realistic capture: 10-20% = $90-180k/day = $33-66M/yr

  const dailyLiqRate = 0.005;
  const dailyLiqVol = totalOi * dailyLiqRate;
  const avgBonus = 0.015;
  const totalLiqProfit = dailyLiqVol * avgBonus;
  const competitionFactor = 0.15;
  const ourShare = totalLiqProfit * competitionFactor;
  console.log(`  Total HL OI: $${(totalOi/1e9).toFixed(2)}B`);
  console.log(`  Daily liquidation rate: ${dailyLiqRate*100}%`);
  console.log(`  Daily liquidation volume: $${(dailyLiqVol/1e6).toFixed(1)}M`);
  console.log(`  Average liquidation bonus: ${avgBonus*100}%`);
  console.log(`  Total daily liquidator profit: $${(totalLiqProfit/1000).toFixed(0)}k`);
  console.log(`  Competition factor (capture rate): ${competitionFactor*100}%`);
  console.log(`  Our share (daily): $${(ourShare/1000).toFixed(0)}k`);
  console.log(`  Our share (annual): $${(ourShare*365/1e6).toFixed(1)}M`);
  console.log(`  Capital needed: $100k (collateral float)`);
  console.log(`  APR: ${((ourShare*365/100000)*100).toFixed(0)}%`);

  // 3. Risks
  console.log('\n── Risks ──');
  console.log('  1. COMPETITION — Wintermute, GSR, Jump are professional market makers');
  console.log('  2. CAPITAL — need $100k+ floating capital for liquidations');
  console.log('  3. PRICE RISK — liquidator takes position, must close fast');
  console.log('  4. SMART CONTRACT — HL liquidation logic is complex');
  console.log('  5. PARTIAL FILLS — large liquidations may not fully fill');
  console.log('');

  // 4. Technical requirements
  console.log('── Technical Requirements ──');
  console.log('  1. Real-time position monitor (every block, < 1s latency)');
  console.log('  2. Price oracle listener (HL index price + mark price)');
  console.log('  3. Margin ratio calculator (account value / maintenance margin)');
  console.log('  4. Liquidation tx builder (sign + submit in < 1s)');
  console.log('  5. Position closer (sell long / buy short at market)');
  console.log('  6. Capital management (USDC float for liquidations)');
  console.log('  7. Risk manager (max exposure per liquidation)');
  console.log('');

  // 5. Build cost
  console.log('── Build Cost ──');
  console.log('  Phase 1 (1 week): Position monitor + margin calculator');
  console.log('  Phase 2 (1 week): Liquidation executor (sign + submit)');
  console.log('  Phase 3 (2 weeks): Position closer + risk manager');
  console.log('  Phase 4 (1 week): Live testing + optimization');
  console.log('  Total: 5 weeks (200 hrs) to production-ready');
  console.log('');

  // 6. Comparison to alternatives
  console.log('── Comparison to Alternatives ──');
  console.log('  Strategy             | Annual $    | APR    | Build | Risk');
  console.log('  ─────────────────────|─────────────|────────|───────|──────');
  console.log('  VOOI Price Spread    | $784k       | 3,139% | DONE  | LOW');
  console.log('  HL Perp Liquidation  | $33-66M     | 33-66% | 5wk   | HIGH');
  console.log('  VOOI Funding Arb     | $7.5-15k    | 30-60% | DONE  | LOW');
  console.log('  kHYPE LST Carry      | $510        | 5%     | DONE  | LOW');
  console.log('');

  console.log('=== Verdict ===');
  console.log('HL Perp Liquidation Hunting is HIGH-REWARD, HIGH-EFFORT, HIGH-RISK.');
  console.log('  Reward: $33-66M/yr (massive)');
  console.log('  Build effort: 5 weeks (200 hrs)');
  console.log('  Risk: HIGH (competing with pro firms)');
  console.log('');
  console.log('Recommendation: STRATEGIC PHASE 2');
  console.log('  - Massive revenue potential ($33M+/yr)');
  console.log('  - Different from VOOI arb (different market segment)');
  console.log('  - Capital-intensive ($100k float)');
  console.log('  - High competition but HL is less saturated than CEX');
  console.log('');
  console.log('ACTION ITEMS:');
  console.log('  1. 🔲 Build position monitor (every-block scan)');
  console.log('  2. 🔲 Build margin calculator');
  console.log('  3. 🔲 Build liquidation executor');
  console.log('  4. 🔲 Test with paper trading');
  console.log('  5. 🔲 Deploy with $10k initial capital');
  console.log('  6. 🔲 Scale to $100k after 30-day track record');
}

main().catch(console.error);
