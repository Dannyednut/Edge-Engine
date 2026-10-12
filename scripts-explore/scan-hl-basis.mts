// HL Perp Basis Trading Scanner
// Basis = Perp price - Spot price
// When basis > 0 (perp premium), short perp + long spot = capture basis
// When basis < 0 (perp discount), long perp + short spot = capture basis
//
// This is delta-neutral arb — same asset, different venues
//
// Hyperliquid specifics:
//   - HL has both spot (HIP-1) and perp for many assets
//   - BTC, ETH, SOL, HYPE, etc.
//   - Funding rate pays/charges perp holders periodically

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
  console.log('  HL Perp Basis Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get HL perp prices
  const perpMeta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const perpUniverse = perpMeta[0].universe || [];
  const perpCtxs = perpMeta[1] || [];
  const perpPrices: Record<string, { price: number; funding: number; vol: number; oi: number }> = {};
  for (let i = 0; i < perpUniverse.length; i++) {
    const name = perpUniverse[i].name || '';
    const markPx = parseFloat(perpCtxs[i]?.markPx || '0');
    const funding = parseFloat(perpCtxs[i]?.funding || '0');
    const vol = parseFloat(perpCtxs[i]?.dayNtlVlm || '0');
    const oi = parseFloat(perpCtxs[i]?.openInterest || '0');
    if (markPx > 0) {
      perpPrices[name] = { price: markPx, funding, vol, oi };
    }
  }

  // 2. Get HL spot prices
  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const spotUniverse = spotMeta[0].universe || [];
  const spotCtxs = spotMeta[1] || [];
  const spotTokens = spotMeta[0].tokens || [];
  const spotPrices: Record<string, { price: number; vol: number }> = {};
  for (let i = 0; i < spotUniverse.length; i++) {
    let name = spotUniverse[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < spotTokens.length) name = spotTokens[idx].name || name;
    }
    const markPx = parseFloat(spotCtxs[i]?.markPx || '0');
    const vol = parseFloat(spotCtxs[i]?.dayNtlVlm || '0');
    if (markPx > 0 && !name.startsWith('@')) {
      spotPrices[name] = { price: markPx, vol };
    }
  }

  console.log(`Loaded ${Object.keys(perpPrices).length} perps, ${Object.keys(spotPrices).length} spot tokens\n`);

  // 3. Find assets that have BOTH perp and spot
  const both: string[] = [];
  for (const name of Object.keys(perpPrices)) {
    if (spotPrices[name]) both.push(name);
  }
  console.log(`── ${both.length} assets with both perp + spot ──\n`);

  // 4. Compute basis for each
  console.log('── Perp Basis (Perp - Spot) ──');
  const results: any[] = [];
  for (const name of both) {
    const perp = perpPrices[name];
    const spot = spotPrices[name];
    const basis = perp.price - spot.price;
    const basisPct = (basis / spot.price) * 100;
    const funding1h = perp.funding * 100; // already in decimal/hour
    const fundingDaily = funding1h * 24;
    const fundingAnnual = fundingDaily * 365;
    // Annual basis carry: if perp premium (basis > 0), short perp earns funding
    // If perp discount (basis < 0), long perp pays funding but we capture basis
    const annualCarry = basisPct + (basisPct > 0 ? fundingAnnual : -fundingAnnual);
    results.push({
      name,
      perp: perp.price,
      spot: spot.price,
      basisPct,
      funding1h,
      fundingAnnual,
      annualCarry,
      spotVol: spot.vol,
      perpVol: perp.vol,
    });
  }
  results.sort((a, b) => Math.abs(b.basisPct) - Math.abs(a.basisPct));

  console.log('Top 20 by basis magnitude:');
  for (const r of results.slice(0, 20)) {
    const direction = r.basisPct > 0 ? 'SHORT PERP/LONG SPOT' : 'LONG PERP/SHORT SPOT';
    const flag = Math.abs(r.basisPct) > 0.5 ? ' ⚠️' : '';
    console.log(`  ${r.name.padEnd(10)} perp=$${r.perp.toFixed(4).padStart(10)} spot=$${r.spot.toFixed(4).padStart(10)} basis=${r.basisPct.toFixed(3).padStart(7)}% fund=${r.funding1h.toFixed(4)}%/h [${direction}]${flag}`);
  }

  // 5. Actionable arbs
  console.log('\n── Actionable Basis Arbs (>0.5% basis) ──');
  const arbs = results.filter(r => Math.abs(r.basisPct) > 0.5);
  if (arbs.length === 0) {
    console.log('  ✅ No basis arbs > 0.5% — HL perp/spot tracking efficiently');
  } else {
    let totalAnnual = 0;
    for (const a of arbs) {
      const profit5k = Math.abs(a.basisPct) / 100 * 5000;
      const annualYield = a.annualCarry;
      totalAnnual += Math.abs(annualYield);
      console.log(`  ${a.name}: basis=${a.basisPct.toFixed(3)}% (1h funding: ${a.funding1h.toFixed(4)}%)`);
      console.log(`    Per cycle on $5k: $${profit5k.toFixed(2)}`);
      console.log(`    Annual carry yield: ${annualYield.toFixed(2)}%`);
      console.log(`    Annual profit on $5k: $${(5000 * Math.abs(annualYield) / 100).toFixed(0)}`);
    }
    console.log(`\n  Total annual yield (sum): ${totalAnnual.toFixed(2)}%`);
    console.log(`  Realistic capture (50%): ${(totalAnnual * 0.5).toFixed(2)}%`);
    console.log(`  On $25k deployed: $${(25000 * totalAnnual * 0.5 / 100).toFixed(0)}/yr`);
  }

  console.log('\n=== Verdict ===');
  if (arbs.length === 0) {
    console.log('✅ HL basis is efficient — no actionable arbs right now');
    console.log('   Basis arbs appear during high volatility (check during market moves)');
  } else {
    console.log(`🚨 ${arbs.length} basis arbs detected`);
    console.log('   This is a NEW strategy not in our 19-strategy scanner!');
    console.log('   Add as strategy #20: HL perp basis arb');
  }
  console.log('');
  console.log('Strategy economics:');
  console.log('  - Delta-neutral (long spot + short perp = no directional risk)');
  console.log('  - Earns: basis capture + funding rate (if perp premium)');
  console.log('  - Capital: 2x notional (both legs)');
  console.log('  - Risk: HL smart contract risk (same as other HL strategies)');
  console.log('');
  console.log('ACTION ITEMS:');
  console.log('  1. 🔲 Add HL basis scanner to all-runner.ts');
  console.log('  2. 🔲 Build HLPerpBasisExecutor');
  console.log('  3. 🔲 Add /basis Telegram command');
  console.log('  4. 🔲 Test with small capital ($1k per leg)');
}

main().catch(console.error);
