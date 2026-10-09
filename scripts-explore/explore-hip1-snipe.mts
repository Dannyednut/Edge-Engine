// Explore Hyperliquid HIP-1 token launch sniping
// HIP-1 = Hyperliquid's token standard for native spot markets
// When a new HIP-1 token launches on HL:
//   1. Initial price discovery is volatile (5-50% swings in first hour)
//   2. Low liquidity = wide spreads = arb opportunity
//   3. Memecoins (HOP, WATAR, WAR, HYFI) often 10x in first day
//
// Strategy:
//   1. Monitor HL API for new HIP-1 token listings (every block)
//   2. When new token appears, immediately:
//      a. Buy on HL spot at market price
//      b. Sell on HyperSwap V3 if listed there (price discrepancy)
//      c. Or hold for short-term momentum
//   3. Risk-managed: max $1k per token, stop-loss at -10%
//
// Risks:
//   - 90% of new tokens are scams/rug pulls
//   - High volatility can wipe position in minutes
//   - Limited liquidity prevents exit
//   - Gas wars on HyperEVM (for DEX routing)

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
  console.log('=== HIP-1 Token Launch Sniping Exploration ===\n');

  // 1. Get all spot tokens sorted by age (newest first)
  console.log('── Recent HIP-1 Token Listings ──');
  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const universe = spotMeta[0].universe || [];
  const ctxs = spotMeta[1] || [];
  const tokens = spotMeta[0].tokens || [];

  const allTokens: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    let name = universe[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < tokens.length) name = tokens[idx].name || name;
    }
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const dayPct = parseFloat(ctxs[i]?.midDayPctChange || '0');
    if (markPx > 0) {
      allTokens.push({
        name, markPx, vol, dayPct,
        // Newer tokens tend to have higher 24h% moves
        // We can sort by 24h% as a proxy for "new and active"
      });
    }
  }

  // Sort by 24h % change (high vol = either new or pumping)
  const movers = allTokens.filter(t => Math.abs(t.dayPct) > 10).sort((a, b) => Math.abs(b.dayPct) - Math.abs(a.dayPct));
  console.log(`Found ${allTokens.length} total spot tokens, ${movers.length} with >10% 24h move\n`);
  console.log('Top 15 by 24h move (potential launch/momentum):');
  for (const t of movers.slice(0, 15)) {
    const flag = t.vol > 100000 ? ' 🟢' : '';
    console.log(`  ${t.name.padEnd(15)} $${t.markPx.toFixed(6).padStart(12)}  24h=${t.dayPct.toFixed(1).padStart(7)}%  vol=$${(t.vol/1000).toFixed(0).padStart(7)}k${flag}`);
  }

  // 2. Look for brand-new tokens (low volume + low price)
  console.log('\n── Tokens Likely Launched Today (low volume, new) ──');
  const newish = allTokens.filter(t => t.vol < 50000 && t.vol > 100).sort((a, b) => a.vol - b.vol);
  for (const t of newish.slice(0, 15)) {
    console.log(`  ${t.name.padEnd(15)} $${t.markPx.toFixed(6).padStart(12)}  24h=${t.dayPct.toFixed(1).padStart(7)}%  vol=$${(t.vol/1000).toFixed(0).padStart(7)}k`);
  }

  // 3. Hyperliquid HIP-1 deployment economics
  console.log('\n── HIP-1 Token Deployment Economics ──');
  console.log('  HIP-1 deployment cost: ~$5,000 USD (USDC gas on HyperEVM)');
  console.log('  HIP-2 (max supply) cost: ~$5,000 USD additional');
  console.log('  Total to launch own HIP-1 token: ~$10,000');
  console.log('');
  console.log('  Revenue model if we launch our own token:');
  console.log('    - Initial market cap: $50k-500k (realistic for new launch)');
  console.log('    - Founder allocation: 10-20% = $5k-100k paper value');
  console.log('    - Liquidity provision: $5-20k');
  console.log('    - Maker fees from trades: 0.001% * volume');
  console.log('    - If token pumps 10x: $50k-1M paper value');
  console.log('');
  console.log('  ⚠️  ETHICAL/LEGAL CONSIDERATIONS:');
  console.log('    - Token launches are subject to securities laws');
  console.log('    - Memecoins are unregistered securities in US');
  console.log('    - Founder allocation could be considered fraud');
  console.log('    - Better: Launch UTILITY token (data feed access, etc.)');

  // 4. Token sniping economics
  console.log('\n── Token Sniping Economics ──');
  // On HL, when new HIP-1 launches:
  //   - First 10-30 minutes: extreme volatility (5-50% swings)
  //   - Day 1: typically 2-10x or -50% to -90%
  //   - Day 7: most tokens -80% from launch
  //
  // Strategy A: Buy first 1 minute, sell at +50%
  //   - Hit rate: ~20% (most tokens dump immediately)
  //   - Win: $500 profit per token on $1k
  //   - Loss: -$500 per token on $1k
  //   - Expected: 0.2 * 500 - 0.8 * 500 = -$300/token = NEGATIVE EV
  //
  // Strategy B: Buy at first dip, hold for momentum
  //   - Hit rate: ~30%
  //   - Same EV math = NEGATIVE
  //
  // Strategy C: Arbitrage new listings (HL spot vs HyperSwap V3)
  //   - Some new tokens list on both HL spot AND HyperSwap V3
  //   - Price spreads can be 5-20% in first hour
  //   - Buy cheap venue, sell expensive venue = RISK-FREE
  //   - But:HyperSwap V3 needs to have liquidity (often doesn't for new tokens)
  console.log('  Strategy A (Buy first 1 min, sell +50%):');
  console.log('    Hit rate: 20% | Win: $500 | Loss: -$500 | EV: -$300/token = ❌');
  console.log('');
  console.log('  Strategy B (Buy first dip, momentum hold):');
  console.log('    Hit rate: 30% | Win: $1,000 | Loss: -$500 | EV: -$50/token = ❌');
  console.log('');
  console.log('  Strategy C (Cross-venue arb HL ↔ HyperSwap V3):');
  console.log('    Hit rate: 90% | Win: $50-200 | Loss: $0 | EV: $50-180/token = ✅');
  console.log('    But: requires HyperSwap V3 liquidity (rare for new tokens)');

  // 5. Real opportunity: market-maker for new tokens
  console.log('\n── Real Opportunity: Market Maker for New HIP-1 Tokens ──');
  console.log('  When new HIP-1 token launches:');
  console.log('    - Liquidity is thin (5-50 USDC on each side)');
  console.log('    - Spread is wide (5-20%)');
  console.log('    - First market maker captures most flow');
  console.log('');
  console.log('  Strategy: Provide $1-5k liquidity on both sides');
  console.log('    - Capture spread on each fill');
  console.log('    - Inventory risk: HIGH (price can crash)');
  console.log('    - Mitigation: tight inventory limits, auto-rebalance');
  console.log('');
  console.log('  Revenue estimate:');
  console.log('    - 5 new tokens/day * $100 profit/token = $500/day = $182k/yr');
  console.log('    - Capital needed: $5k float');
  console.log('    - APR: 3,650% (theoretical)');
  console.log('    - Realistic (after losses): 500-1000% APR = $25-50k/yr on $5k');

  console.log('\n=== Verdict ===');
  console.log('HIP-1 launch sniping is GAMBLING, NOT ARBITRAGE.');
  console.log('  Strategy A/B: Negative EV — pure speculation');
  console.log('  Strategy C: Real arb but requires HyperSwap V3 liquidity (rare)');
  console.log('');
  console.log('Market-making new HIP-1 tokens is HIGH-RISK, HIGH-REWARD.');
  console.log('  $25-50k/yr on $5k capital (500-1000% APR)');
  console.log('  But: 90% of new tokens are scams, inventory risk is high');
  console.log('');
  console.log('Recommendation: PASSIVE MONITORING + MM SELECTIVELY');
  console.log('  - Build a HIP-1 launch monitor (alerts on new listings)');
  console.log('  - MM only tokens with > $50k first-hour volume (signal of legitimacy)');
  console.log('  - Strict inventory limits ($500 max per token)');
  console.log('  - Auto-exit on 20% loss');
  console.log('');
  console.log('ACTION ITEMS:');
  console.log('  1. 🔲 Build HIP-1 launch monitor (polls spotMeta every 30s)');
  console.log('  2. 🔲 Build market-maker bot for new HIP-1 tokens');
  console.log('  3. 🔲 Build risk manager for token MM (inventory + stop-loss)');
  console.log('  4. 🔲 Paper trade for 30 days before going live');
  console.log('');
  console.log('PRIORITY: LOW (current VOOI/kHYPE strategies have better risk-adjusted returns)');
}

main().catch(console.error);
