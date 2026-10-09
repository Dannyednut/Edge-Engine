// Explore HL Perp Spot Delta-Neutral Strategy
// Different from funding arb:
//   - Funding arb: capture funding rate difference between two perps
//   - Spot-perp delta-neutral: long spot + short perp = delta neutral, capture basis + funding
//
// When perp is in contango (perp > spot):
//   - Long spot, short perp
//   - Earn: perp funding (longs pay shorts when perp premium) + basis converges at expiry
//
// When perp is in backwardation (perp < spot):
//   - Short spot (via borrow), long perp
//   - Earn: perp funding (shorts pay longs when perp discount) + basis converges
//
// Hyperliquid specifics:
//   - HL perps are perpetual (no expiry)
//   - Basis = perp mark price - spot mark price
//   - Funding rate keeps perp tethered to spot

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
  console.log('  HL Perp Spot Delta-Neutral Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get perp + spot prices
  console.log('── Loading HL perp + spot prices ──');
  const perpMeta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const perpUniverse = perpMeta[0].universe || [];
  const perpCtxs = perpMeta[1] || [];

  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const spotUniverse = spotMeta[0].universe || [];
  const spotCtxs = spotMeta[1] || [];
  const spotTokens = spotMeta[0].tokens || [];

  // Build perp prices
  const perpPrices: Record<string, { price: number; funding: number; vol: number; oi: number }> = {};
  for (let i = 0; i < perpUniverse.length; i++) {
    const name = perpUniverse[i].name || '';
    const markPx = parseFloat(perpCtxs[i]?.markPx || '0');
    const funding = parseFloat(perpCtxs[i]?.funding || '0');
    const vol = parseFloat(perpCtxs[i]?.dayNtlVlm || '0');
    const oi = parseFloat(perpCtxs[i]?.openInterest || '0');
    if (markPx > 0) perpPrices[name] = { price: markPx, funding, vol, oi };
  }

  // Build spot prices
  const spotPrices: Record<string, { price: number; vol: number }> = {};
  for (let i = 0; i < spotUniverse.length; i++) {
    let name = spotUniverse[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < spotTokens.length) name = spotTokens[idx].name || name;
    }
    const markPx = parseFloat(spotCtxs[i]?.markPx || '0');
    const vol = parseFloat(spotCtxs[i]?.dayNtlVlm || '0');
    if (markPx > 0 && !name.startsWith('@')) spotPrices[name] = { price: markPx, vol };
  }

  console.log(`  Loaded ${Object.keys(perpPrices).length} perps, ${Object.keys(spotPrices).length} spot tokens\n`);

  // 2. Find assets with both perp + spot
  const both: string[] = [];
  for (const name of Object.keys(perpPrices)) {
    if (spotPrices[name]) both.push(name);
  }
  console.log(`── ${both.length} assets with both perp + spot ──\n`);

  // 3. Compute basis + delta-neutral yield
  console.log('── Delta-Neutral Opportunities ──');
  console.log('Asset     | Perp $      | Spot $      | Basis %  | Funding/h % | Annual %  | Action');
  console.log('──────────|─────────────|─────────────|──────────|─────────────|───────────|──────────────');

  const opportunities: any[] = [];
  for (const name of both) {
    const perp = perpPrices[name];
    const spot = spotPrices[name];
    if (perp.price <= 0 || spot.price <= 0) continue;
    if (spot.vol < 50000) continue; // need decent spot volume

    const basis = (perp.price - spot.price) / spot.price * 100;
    const funding1h = perp.funding * 100;
    const fundingAnnual = funding1h * 24 * 365;

    // Strategy:
    // If perp > spot (basis > 0, contango):
    //   Long spot, short perp
    //   Profit = funding (longs pay shorts when perp premium) + basis converges
    // If perp < spot (basis < 0, backwardation):
    //   Short spot, long perp
    //   Profit = funding (shorts pay longs when perp discount) + basis converges

    let action = '';
    let annualReturn = 0;
    if (basis > 0.1) {
      // Contango — long spot, short perp
      action = 'LONG SPOT / SHORT PERP';
      // Funding is typically positive in contango (longs pay shorts)
      annualReturn = fundingAnnual + basis * 30; // basis converges ~30x/yr (rough)
    } else if (basis < -0.1) {
      // Backwardation — short spot, long perp
      action = 'SHORT SPOT / LONG PERP';
      annualReturn = -fundingAnnual + Math.abs(basis) * 30;
    } else {
      continue; // basis too small
    }

    if (Math.abs(basis) < 0.05) continue; // filter tiny basis

    opportunities.push({
      name,
      perp: perp.price,
      spot: spot.price,
      basis,
      funding1h,
      fundingAnnual,
      annualReturn,
      action,
    });

    console.log(`${name.padEnd(10)}| $${perp.price.toFixed(4).padStart(11)} | $${spot.price.toFixed(4).padStart(11)} | ${basis.toFixed(3).padStart(8)}% | ${funding1h.toFixed(4).padStart(11)}% | ${annualReturn.toFixed(1).padStart(9)}% | ${action}`);
  }

  // 4. Top opportunities
  console.log('\n── Top Delta-Neutral Opportunities (by annual return) ──');
  opportunities.sort((a, b) => Math.abs(b.annualReturn) - Math.abs(a.annualReturn));
  for (const o of opportunities.slice(0, 10)) {
    console.log(`  ${o.name}: ${o.action}`);
    console.log(`    Basis: ${o.basis.toFixed(3)}% | Funding: ${o.funding1h.toFixed(4)}%/h (${o.fundingAnnual.toFixed(0)}%/yr)`);
    console.log(`    Est. annual return: ${o.annualReturn.toFixed(1)}%`);
    console.log(`    On $10k: $${(10000 * o.annualReturn / 100).toFixed(0)}/yr`);
  }

  console.log('\n=== Verdict ===');
  if (opportunities.length === 0) {
    console.log('No delta-neutral opportunities found (basis too small)');
  } else {
    console.log(`Found ${opportunities.length} delta-neutral opportunities`);
    const top = opportunities[0];
    console.log(`Top: ${top.name} at ${top.annualReturn.toFixed(1)}% APR = $${(10000 * top.annualReturn / 100).toFixed(0)}/yr on $10k`);
  }
  console.log('');
  console.log('NOTE: HL basis scanner exists but has data quality issues.');
  console.log('  Spot prices for HIP-1 tokens may be in different quote currencies.');
  console.log('  Need to verify each pair manually before executing.');
}

main().catch(console.error);
