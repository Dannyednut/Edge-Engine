// HIP-3 Stock Arb Scanner v3 — uses VOOI to get alias: markets on HL, compares to Yahoo

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

const VOI_API = 'https://perps-api.vooi.io';

async function vooiScan(params: any): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${VOI_API}/arbitrage-scanner?${q.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`VOOI ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getYahooPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

// Load ALIAS_MAP entries
const ALIAS_MAP_PATH = '/home/z/my-project/edge-engine/packages/scanner/src/lib/alias-ticker-map.ts';
const aliasSource = readFileSync(ALIAS_MAP_PATH, 'utf8');
const aliasEntries: { alias: string; yahoo: string; name: string; cls: string }[] = [];
const regex = /'([a-z0-9]+)':\s*\{\s*alias:[^}]+realName:\s*'([^']+)'[^}]+assetClass:\s*'([^']+)'[^}]*yahooSymbol:\s*'([^']+)'[^}]*\}/g;
let m;
while ((m = regex.exec(aliasSource)) !== null) {
  aliasEntries.push({ alias: m[1], name: m[2], cls: m[3], yahoo: m[4] });
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HIP-3 Stock Arb Scanner (VOOI + Yahoo)');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Query VOOI for all HIP-3 alias: markets
  console.log('── Loading VOOI markets ──');
  const vooiResp = await vooiScan({ limit: 200, orderBy: 'priceSpread', orderDirection: 'desc' });
  const items = vooiResp?.items || [];
  console.log(`  Loaded ${items.length} asset groups, ${vooiResp?.total || 0} total\n`);

  // Flatten: each item has asset (e.g., "alias:unh") and pairs[]
  const flatPairs: any[] = [];
  for (const item of items) {
    if (!item.asset || !item.asset.startsWith('alias:')) continue;
    for (const p of (item.pairs || [])) {
      flatPairs.push({ asset: item.asset, ...p });
    }
  }
  console.log(`  Found ${flatPairs.length} alias: pairs across all venues\n`);

  // 2. Filter to pairs where one venue is hyperliquid
  const hlPairs = flatPairs.filter(p =>
    p.long?.exchange === 'hyperliquid' || p.short?.exchange === 'hyperliquid'
  );
  console.log(`  Found ${hlPairs.length} pairs with HL as one venue\n`);

  // 3. For each HL pair, get HL price + Yahoo price + compute spread
  console.log('── Cross-Venue Spreads (HL HIP-3 vs Yahoo Stock) ──');
  const arbs: any[] = [];

  // Process top 50 by volume
  const sorted = hlPairs
    .map(p => {
      const hlSide = p.long?.exchange === 'hyperliquid' ? p.long : (p.short?.exchange === 'hyperliquid' ? p.short : null);
      const otherSide = p.long?.exchange === 'hyperliquid' ? p.short : p.long;
      return {
        asset: p.asset,
        hl: hlSide,
        other: otherSide,
        fundingSpread1h: p.fundingSpread1h,
        priceSpread: p.priceSpread,
      };
    })
    .filter(p => p.hl)
    .sort((a, b) => (b.hl.volume24h || 0) - (a.hl.volume24h || 0))
    .slice(0, 50);

  console.log(`  Scanning top ${sorted.length} HL HIP-3 markets by volume...\n`);

  for (const p of sorted) {
    const aliasKey = p.asset.replace('alias:', '');
    const entry = aliasEntries.find(a => a.alias === aliasKey);
    if (!entry) {
      continue;
    }
    const hlPx = parseFloat(p.hl.price || '0');
    if (hlPx <= 0) continue;
    const yPx = await getYahooPrice(entry.yahoo);
    if (!yPx) continue;
    const spread = ((hlPx - yPx) / yPx) * 100;
    const flag = Math.abs(spread) > 1 ? ' ⚠️' : '';
    const flag2 = Math.abs(spread) > 3 ? ' 🚨' : flag;
    console.log(`  ${entry.alias.padEnd(8)} ${entry.yahoo.padEnd(8)} HL=$${hlPx.toFixed(4).padStart(10)}  Yahoo=$${yPx.toFixed(4).padStart(10)}  spread=${spread.toFixed(3).padStart(7)}%  vol=$${((p.hl.volume24h || 0)/1000).toFixed(0).padStart(7)}k${flag2}`);
    if (Math.abs(spread) > 0.5) {
      arbs.push({
        alias: entry.alias,
        yahoo: entry.yahoo,
        name: entry.name,
        hl: hlPx,
        yahoo_px: yPx,
        spreadPct: spread,
        volume: p.hl.volume24h || 0,
        otherVenue: p.other?.exchange,
        otherPrice: parseFloat(p.other?.price || '0'),
        vooiPriceSpread: p.priceSpread,
      });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // 4. Actionable arbs
  console.log('\n── Actionable Arbitrage Opportunities ──');
  arbs.sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
  if (arbs.length === 0) {
    console.log('  ✅ No arbs > 0.5% — HL HIP-3 tracking Yahoo efficiently');
  } else {
    for (const a of arbs.slice(0, 20)) {
      if (Math.abs(a.spreadPct) < 0.5) continue;
      const direction = a.spreadPct > 0 ? 'SHORT HL / LONG STOCK' : 'LONG HL / SHORT STOCK';
      const profit5k = Math.abs(a.spreadPct) / 100 * 5000;
      console.log(`  ${a.alias.padEnd(8)} ${a.yahoo.padEnd(8)} ${a.name.substring(0, 30).padEnd(30)} ${a.spreadPct.toFixed(3).padStart(7)}% ${direction}`);
      console.log(`    HL=$${a.hl.toFixed(4)} Yahoo=$${a.yahoo_px.toFixed(4)} vol=$${(a.volume/1000).toFixed(0)}k  Profit on $5k: $${profit5k.toFixed(0)}`);
    }
  }

  console.log('\n── Summary ──');
  console.log(`  Total HL HIP-3 pairs: ${hlPairs.length}`);
  console.log(`  Verified Yahoo matches: ${arbs.length}`);
  console.log(`  Arbs > 0.5%: ${arbs.length}`);
  console.log(`  Arbs > 1%: ${arbs.filter(a => Math.abs(a.spreadPct) > 1).length}`);
  console.log(`  Arbs > 3%: ${arbs.filter(a => Math.abs(a.spreadPct) > 3).length}`);

  console.log('\n=== Verdict ===');
  const bigArbs = arbs.filter(a => Math.abs(a.spreadPct) > 1);
  if (bigArbs.length > 0) {
    console.log('🚨 LIVE ARBS DETECTED — execute via VOOI price spread executor');
    console.log(`  Top arb: ${bigArbs[0].alias} at ${bigArbs[0].spreadPct.toFixed(3)}% = $${(Math.abs(bigArbs[0].spreadPct)/100*5000).toFixed(0)} profit on $5k`);
  } else {
    console.log('✅ HL HIP-3 prices tracking Yahoo efficiently');
    console.log('   Market is competitive — spreads < 1%');
  }
}

main().catch(console.error);
