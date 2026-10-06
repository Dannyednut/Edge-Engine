/**
 * Discovery runner — performs a one-shot scan of all data sources
 * and prints what's available.  Useful for sanity-checking integrations.
 */

import { loadConfig } from '@edge/config';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient } from '@edge/vooi-client';

// Resolve repo root (4 levels up from this file: runners/ → src/ → scanner/ → packages/ → repo)
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

async function main() {
  const cfg = loadConfig(REPO_ROOT);
  const sharpe = new SharpeClient({ apiKey: cfg.apis.sharpe?.apiKey });
  const vooi   = new VooiClient({ apiToken: cfg.apis.vooi?.apiToken });

  console.log('── Sharpe.ai /cross-exchange ─────────────────────');
  try {
    const r = await sharpe.crossExchangeFunding({ minApr: 5, minOiUsd: 50_000 });
    console.log(`  ${r.data.length} rows`);
    for (const row of r.data.slice(0, 5)) {
      console.log(`    ${(row.coin || row.asset || '').padEnd(10)} long=${(row.longExchange || '').padEnd(15)} short=${(row.shortExchange || '').padEnd(15)} netApr=${(row.netApr ?? 0).toFixed(2)}%`);
    }
  } catch (err) {
    console.log(`  ✗ ${err}`);
  }

  console.log('── VOOI /arbitrage-scanner ───────────────────────');
  try {
    const r = await vooi.scanArbitrage({
      minFundingSpread: 0,
      minOpenInterest: 50_000,
      notionalUsd: 5000,
      orderBy: 'fundingSpread1h',
      orderDirection: 'desc',
      limit: 20,
    });
    console.log(`  ${r.total} pairs total`);
    for (const item of r.items.slice(0, 5)) {
      const top = item.pairs[0];
      if (!top) continue;
      const f1h = (top.fundingSpread1h * 100).toFixed(3);
      const ps  = ((top.priceSpread ?? 0) * 100).toFixed(3);
      console.log(`    ${item.asset.padEnd(10)} long=${top.long.exchange.padEnd(15)} short=${top.short.exchange.padEnd(15)} f1h=${f1h}% priceSpread=${ps}%`);
    }
  } catch (err) {
    console.log(`  ✗ ${err}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
