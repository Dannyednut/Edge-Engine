// Continuous Opportunity Logger
// Tracks all opportunities seen over time, so we can:
//   - See which strategies actually fire
//   - Compute realistic capture rates
//   - Track opportunity frequency
//
// Run periodically, append to log file

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const VOI_API = 'https://perps-api.vooi.io';
const OPP_LOG = '/home/z/my-project/download/opportunity-log.jsonl';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function vooiScan(params: any): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${VOI_API}/arbitrage-scanner?${q.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return { items: [], total: 0 };
  return res.json();
}

function logOpp(entry: any) {
  const line = JSON.stringify(entry) + '\n';
  if (existsSync(OPP_LOG)) {
    const existing = readFileSync(OPP_LOG, 'utf8').split('\n').filter(l => l.trim());
    existing.push(JSON.stringify(entry));
    writeFileSync(OPP_LOG, existing.join('\n') + '\n');
  } else {
    writeFileSync(OPP_LOG, line);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Opportunity Logger');
  console.log('═══════════════════════════════════════════════════\n');

  const ts = Date.now();
  let logged = 0;

  // 1. VOOI Price Spread opportunities
  const vooiResp = await vooiScan({ limit: 50, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.005 });
  for (const item of (vooiResp?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      const longEx = p.long?.exchange || '?';
      const shortEx = p.short?.exchange || '?';
      const longPx = parseFloat(p.long?.price || '0');
      const shortPx = parseFloat(p.short?.price || '0');
      const profit5k = 5000 * spread / 100 - 5000 * 0.003;
      logOpp({
        ts,
        type: 'price_spread',
        asset: item.asset,
        spreadPct: spread,
        longVenue: longEx,
        shortVenue: shortEx,
        longPrice: longPx,
        shortPrice: shortPx,
        profit5k,
        volume: p.long?.volume24h || 0,
      });
      logged++;
    }
  }

  // 2. VOOI Funding Rate opportunities
  const vooiFundingResp = await vooiScan({ limit: 50, orderBy: 'fundingSpread1h', orderDirection: 'desc', minFundingSpread: 0.0005 });
  for (const item of (vooiFundingResp?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.fundingSpread1h || 0) * 100;
      const annualApr = spread * 24 * 365;
      if (annualApr < 30 || annualApr > 200) continue; // broader than executor range
      const longEx = p.long?.exchange || '?';
      const shortEx = p.short?.exchange || '?';
      logOpp({
        ts,
        type: 'funding_spread',
        asset: item.asset,
        spread1h: spread,
        annualApr,
        longVenue: longEx,
        shortVenue: shortEx,
        inExecutorRange: annualApr >= 70 && annualApr <= 120,
      });
      logged++;
    }
  }

  // 3. HL perp funding rates (positive only)
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (Math.abs(funding) > 0.0001 && vol > 1_000_000) {
      const annualApr = funding * 24 * 365 * 100;
      logOpp({
        ts,
        type: 'hl_perp_funding',
        asset: name,
        funding1hPct: funding * 100,
        annualApr,
        volume24h: vol,
      });
      logged++;
    }
  }

  console.log(`Logged ${logged} opportunities to ${OPP_LOG}`);

  // 4. Print summary of unique opportunities
  const allOpps = readFileSync(OPP_LOG, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const byType: Record<string, number> = {};
  for (const o of allOpps) {
    byType[o.type] = (byType[o.type] || 0) + 1;
  }
  console.log(`\nTotal logged (all time): ${allOpps.length}`);
  console.log('By type:');
  for (const [t, c] of Object.entries(byType)) {
    console.log(`  ${t}: ${c}`);
  }

  // 5. Top opportunities by profit potential
  console.log('\n── Top 10 Price Spread Opportunities (by profit on $5k) ──');
  const priceOpps = allOpps.filter(o => o.type === 'price_spread' && o.ts === ts);
  priceOpps.sort((a, b) => b.profit5k - a.profit5k);
  for (const o of priceOpps.slice(0, 10)) {
    console.log(`  ${o.asset.padEnd(20)} spread=${o.spreadPct.toFixed(2)}%  ${o.longVenue}→${o.shortVenue}  profit=$${o.profit5k.toFixed(0)}`);
  }

  console.log('\n── Top 10 Funding Rate Opportunities (by APR) ──');
  const fundingOpps = allOpps.filter(o => o.type === 'funding_spread' && o.ts === ts);
  fundingOpps.sort((a, b) => b.annualApr - a.annualApr);
  for (const o of fundingOpps.slice(0, 10)) {
    const flag = o.inExecutorRange ? ' ✅' : '';
    console.log(`  ${o.asset.padEnd(20)} APR=${o.annualApr.toFixed(0)}%  ${o.longVenue}→${o.shortVenue}${flag}`);
  }
}

main().catch(console.error);
