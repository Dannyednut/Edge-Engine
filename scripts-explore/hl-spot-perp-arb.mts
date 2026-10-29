import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

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
  console.log('── HL Spot vs Perp Price Arb Scanner ──\n');

  const [perpMeta, spotMeta] = await Promise.all([
    hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
    hlInfo({ type: 'spotMetaAndAssetCtxs' }),
  ]);

  const perpUniverse = perpMeta?.[0]?.universe || [];
  const perpCtxs = perpMeta?.[1] || [];
  const spotUniverse = spotMeta?.[0]?.universe || [];
  const spotCtxs = spotMeta?.[1] || [];
  const spotTokens = spotMeta?.[0]?.tokens || [];

  // Build perp prices
  const perpPrices: Record<string, { price: number; funding: number; vol: number }> = {};
  for (let i = 0; i < perpUniverse.length; i++) {
    const name = perpUniverse[i].name || '';
    const px = parseFloat(perpCtxs[i]?.markPx || '0');
    const funding = parseFloat(perpCtxs[i]?.funding || '0');
    const vol = parseFloat(perpCtxs[i]?.dayNtlVlm || '0');
    if (px > 0) perpPrices[name] = { price: px, funding, vol };
  }

  // Build spot prices
  const spotPrices: Record<string, { price: number; vol: number }> = {};
  for (let i = 0; i < spotUniverse.length; i++) {
    let name = spotUniverse[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < spotTokens.length) name = spotTokens[idx].name || name;
    }
    const px = parseFloat(spotCtxs[i]?.markPx || '0');
    const vol = parseFloat(spotCtxs[i]?.dayNtlVlm || '0');
    if (px > 0 && !name.startsWith('@')) spotPrices[name] = { price: px, vol };
  }

  // Find matching assets
  const arbs: any[] = [];
  for (const [name, perp] of Object.entries(perpPrices)) {
    const spot = spotPrices[name];
    if (!spot) continue;
    if (perp.vol < 1_000_000 || spot.vol < 10_000) continue;

    const basis = ((perp.price - spot.price) / spot.price) * 100;
    if (Math.abs(basis) > 0.05) {
      const fundingAnnual = perp.funding * 24 * 365 * 100;
      const direction = basis > 0 ? 'SHORT_PERP_LONG_SPOT' : 'LONG_PERP_SHORT_SPOT';
      const profit5k = Math.abs(basis) / 100 * 5000;
      arbs.push({ name, perpPrice: perp.price, spotPrice: spot.price, basis, fundingAnnual, direction, profit5k, perpVol: perp.vol, spotVol: spot.vol });
    }
  }

  arbs.sort((a, b) => Math.abs(b.basis) - Math.abs(a.basis));
  console.log(`Found ${arbs.length} spot-perp basis opportunities\n`);
  console.log('Name       | Perp $       | Spot $       | Basis %  | Funding APR | Direction              | Profit $5k');
  console.log('───────────|──────────────|──────────────|──────────|─────────────|────────────────────────|───────────');
  for (const a of arbs.slice(0, 20)) {
    console.log(`${a.name.padEnd(11)}| $${a.perpPrice.toFixed(4).padStart(12)}| $${a.spotPrice.toFixed(4).padStart(12)}| ${a.basis.toFixed(3).padStart(8)}%| ${a.fundingAnnual.toFixed(0).padStart(11)}%| ${a.direction.padEnd(22)}| $${a.profit5k.toFixed(2)}`);
  }

  if (arbs.length === 0) {
    console.log('  No basis arbs > 0.05% — HL spot/perp tracking efficiently');
  }
}
main().catch(console.error);
