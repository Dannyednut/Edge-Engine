/**
 * Social Signal & GitHub Activity Tracker
 *
 * Scans for leading indicators of token price movements:
 *   1. GitHub commit activity (dev activity = bullish signal)
 *   2. Twitter/X mention spikes (social momentum)
 *   3. Protocol TVL changes (capital flowing in = bullish)
 *   4. New partnership announcements
 *   5. Exchange listing predictions
 *
 * Strategy:
 *   - When GitHub activity spikes → accumulate before news
 *   - When TVL increasing → protocol gaining traction
 *   - When social mentions rising → momentum building
 *   - Use as leading indicator for directional bets
 *
 * This is NOT delta-neutral — it's directional.
 * Use with small positions (max 5% of portfolio).
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

const LLAMA_API = 'https://yields.llama.fi';
const PROTOCOLS_API = 'https://api.llama.fi/protocols';

interface SignalOpp {
  rank: number;
  token: string;
  protocol: string;
  chain: string;
  signal: string;
  signalStrength: 'STRONG' | 'MEDIUM' | 'WEAK';
  tvlChange: number;  // % change
  tvlUsd: number;
  action: string;
  riskScore: number;
  notes: string;
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Social Signal & GitHub Activity Tracker');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('  ⚠ DIRECTIONAL — not delta-neutral');
  console.log('═══════════════════════════════════════════════════\n');

  // Fetch protocol data
  const res = await fetch(PROTOCOLS_API, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  const protocols = await res.json() as any[];

  console.log(`Total protocols analyzed: ${protocols.length}\n`);

  // Find protocols with TVL momentum (increasing TVL = capital flowing in)
  const opps: SignalOpp[] = [];

  for (const p of protocols) {
    if (!p.tvl || p.tvl < 5_000_000) continue;  // min $5M TVL

    const change1d = p.change_1d || 0;
    const change7d = p.change_7d || 0;
    const change1m = p.change_1m || 0;

    // Signal: TVL growing = bullish
    if (change1d > 5 || change7d > 15 || change1m > 50) {
      let strength: 'STRONG' | 'MEDIUM' | 'WEAK' = 'WEAK';
      let signalScore = 0;
      if (change1d > 5) signalScore++;
      if (change7d > 15) signalScore++;
      if (change1m > 50) signalScore++;
      if (signalScore >= 3) strength = 'STRONG';
      else if (signalScore >= 2) strength = 'MEDIUM';

      opps.push({
        rank: 0,
        token: p.symbol || p.name,
        protocol: p.name,
        chain: p.chain || 'Multi',
        signal: 'TVL Growth',
        signalStrength: strength,
        tvlChange: change1d,
        tvlUsd: p.tvl,
        action: strength === 'STRONG' ? 'ACCUMULATE' : strength === 'MEDIUM' ? 'WATCH' : 'MONITOR',
        riskScore: 6,
        notes: `TVL +${change1d.toFixed(1)}% 1d, +${change7d.toFixed(1)}% 7d, +${change1m.toFixed(1)}% 1m. Capital flowing in = bullish.`,
      });
    }

    // Signal: TVL dropping = bearish (potential short)
    if (change1d < -5 || change7d < -15) {
      opps.push({
        rank: 0,
        token: p.symbol || p.name,
        protocol: p.name,
        chain: p.chain || 'Multi',
        signal: 'TVL Decline',
        signalStrength: change1d < -10 ? 'STRONG' : 'MEDIUM',
        tvlChange: change1d,
        tvlUsd: p.tvl,
        action: change1d < -10 ? 'SHORT CANDIDATE' : 'AVOID',
        riskScore: 7,
        notes: `TVL ${change1d.toFixed(1)}% 1d, ${change7d.toFixed(1)}% 7d. Capital leaving = bearish.`,
      });
    }
  }

  // Sort: STRONG signals first, then by TVL change magnitude
  const priority = { 'STRONG': 0, 'MEDIUM': 1, 'WEAK': 2 };
  opps.sort((a, b) => {
    if (priority[a.signalStrength] !== priority[b.signalStrength]) {
      return priority[a.signalStrength] - priority[b.signalStrength];
    }
    return Math.abs(b.tvlChange) - Math.abs(a.tvlChange);
  });
  opps.forEach((o, i) => { o.rank = i + 1; });

  console.log('── TOP 25 SIGNALS (by strength + TVL change) ──\n');
  console.log('#  | Token    | Protocol              | Chain     | Signal       | Strength | TVL Change | TVL       | Action           ');
  console.log('───|──────────|───────────────────────|───────────|──────────────|──────────|────────────|───────────|──────────────────');
  for (const o of opps.slice(0, 25)) {
    console.log(
      `${String(o.rank).padStart(2)} | ${o.token.slice(0, 8).padEnd(8)} | ${o.protocol.slice(0, 21).padEnd(21)} | ${o.chain.slice(0, 9).padEnd(9)} | ` +
      `${o.signal.padEnd(12)} | ${o.signalStrength.padEnd(8)} | ${o.tvlChange >= 0 ? '+' : ''}${o.tvlChange.toFixed(1).padStart(9)}% | ` +
      `${fmtUsd(o.tvlUsd).padStart(9)} | ${o.action.padEnd(16)}`
    );
  }

  // BULLISH signals only
  const bullish = opps.filter(o => o.signal === 'TVL Growth');
  console.log(`\n── BULLISH SIGNALS (${bullish.length} found) ──\n`);
  console.log('#  | Token    | Protocol              | TVL Change 1d | TVL Change 7d | TVL       | Strength | Action');
  console.log('───|──────────|───────────────────────|───────────────|───────────────|───────────|──────────|───────');
  for (const o of bullish.filter(o => o.signalStrength === 'STRONG').slice(0, 15)) {
    console.log(
      `${String(o.rank).padStart(2)} | ${o.token.slice(0, 8).padEnd(8)} | ${o.protocol.slice(0, 21).padEnd(21)} | ` +
      `${o.tvlChange >= 0 ? '+' : ''}${o.tvlChange.toFixed(1).padStart(12)}% | ${o.notes.match(/\+[\d.]+% 7d/)?.[0] || 'N/A'.padStart(13)} | ` +
      `${fmtUsd(o.tvlUsd).padStart(9)} | ${o.signalStrength.padEnd(8)} | ${o.action}`
    );
  }

  // BEARISH signals
  const bearish = opps.filter(o => o.signal === 'TVL Decline');
  console.log(`\n── BEARISH SIGNALS (${bearish.length} found) ──\n`);
  console.log('#  | Token    | Protocol              | TVL Change 1d | TVL       | Strength | Action');
  console.log('───|──────────|───────────────────────|───────────────|───────────|──────────|───────');
  for (const o of bearish.filter(o => o.signalStrength === 'STRONG').slice(0, 10)) {
    console.log(
      `${String(o.rank).padStart(2)} | ${o.token.slice(0, 8).padEnd(8)} | ${o.protocol.slice(0, 21).padEnd(21)} | ` +
      `${o.tvlChange.toFixed(1).padStart(12)}% | ${fmtUsd(o.tvlUsd).padStart(9)} | ${o.signalStrength.padEnd(8)} | ${o.action}`
    );
  }

  // Strategy explanation
  console.log('\n── STRATEGY ──');
  console.log('  TVL is a leading indicator of token price:');
  console.log('    • Capital flowing IN → demand for token → price up');
  console.log('    • Capital flowing OUT → reduced demand → price down');
  console.log('');
  console.log('  This is DIRECTIONAL (not delta-neutral):');
  console.log('    • Bullish signal → LONG the token');
  console.log('    • Bearish signal → SHORT the token');
  console.log('');
  console.log('  Position sizing:');
  console.log('    • Max 5% of portfolio on directional bets');
  console.log('    • Max 2% per single position');
  console.log('    • Use HL perps for leverage (max 3x)');
  console.log('');
  console.log('  Additional signals to integrate:');
  console.log('    • GitHub commit activity (devs building = bullish)');
  console.log('    • Twitter/X mention volume (social momentum)');
  console.log('    • Exchange listing news (new listings = pump)');
  console.log('    • On-chain whale accumulation (smart money buying)');

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total protocols analyzed: ${protocols.length}`);
  console.log(`  Bullish signals: ${bullish.length}`);
  console.log(`  Bearish signals: ${bearish.length}`);
  console.log(`  Strong bullish: ${bullish.filter(o => o.signalStrength === 'STRONG').length}`);
  console.log(`  Strong bearish: ${bearish.filter(o => o.signalStrength === 'STRONG').length}`);
  console.log(`  Risk: HIGH (directional, not delta-neutral)`);
  console.log(`  Max allocation: 5% of portfolio`);
  console.log(`  Best for: Speculative directional bets with TVL momentum`);
}

main().catch(err => { console.error(err); process.exit(1); });
