// Debug kHYPE scanner
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { HlLstArbScanner } from '../packages/scanner/src/strategies/hl-lst-arb-scanner.ts';
import { HYPERSWAP_V3_POOLS, HL_TOKEN_DECIMALS, HYPERLEND_FLASHLOAN_FEE, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  return (await r.json() as any).result || '0x';
}

// Manually check each pool
const khypePools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/kHYPE');
console.log(`Found ${khypePools.length} WHYPE/kHYPE pools`);
console.log(`Flashloan fee: ${HYPERLEND_FLASHLOAN_FEE * 100}%`);

for (const pool of khypePools) {
  console.log(`\nPool: ${pool.pair} fee=${pool.fee}bps addr=${pool.address}`);
  
  const slot0 = await ethCall(pool.address, '0x3850c7bd');
  if (slot0.length < 66) { console.log('  No slot0 data'); continue; }
  
  const sqrtPriceX96 = BigInt('0x' + slot0.slice(2, 66));
  const dec0 = HL_TOKEN_DECIMALS['WHYPE'] ?? 18;
  const dec1 = HL_TOKEN_DECIMALS['kHYPE'] ?? 18;
  const price = v3PriceToHuman(sqrtPriceX96, dec0, dec1);
  console.log(`  Price: ${price} (sqrtPriceX96: ${sqrtPriceX96})`);
  
  if (price <= 0 || price > 2) { console.log('  Sanity check failed'); continue; }
  
  const discountPct = (1 - price) * 100;
  console.log(`  Discount: ${discountPct.toFixed(4)}%`);
  
  const liqHex = await ethCall(pool.address, '0x1a686502');
  const liquidity = liqHex.length >= 66 ? BigInt('0x' + liqHex.slice(2, 66)) : 0n;
  console.log(`  Liquidity: ${liquidity}`);
  
  if (liquidity === 0n) { console.log('  No liquidity — SKIP'); continue; }
  
  const ammFeePct = (pool.fee / 10000) * 100;
  const flashloanFeePct = HYPERLEND_FLASHLOAN_FEE * 100;
  const estimatedProfitPct = discountPct - ammFeePct - flashloanFeePct;
  console.log(`  AMM fee: ${ammFeePct}% | Flashloan fee: ${flashloanFeePct}%`);
  console.log(`  Estimated profit: ${estimatedProfitPct.toFixed(4)}%`);
  
  if (estimatedProfitPct <= 0) { console.log('  NOT PROFITABLE — SKIP'); continue; }
  
  console.log(`  ✅ PROFITABLE! Profit on $5k: $${(estimatedProfitPct / 100 * 5000).toFixed(2)}`);
}

// Now run the actual scanner
console.log('\n── Running Scanner ──');
const scanner = new HlLstArbScanner({
  minDiscountPct: 0.1,
  maxSizeUsd: 5_000,
  preferredFeeTier: 100,
});
const alerts = await scanner.scan();
console.log(`Alerts: ${alerts.length}`);
for (const a of alerts) {
  console.log(`  ${a.pair}: discount=${a.discountPct.toFixed(2)}% profit=$${a.estimatedProfitUsd.toFixed(2)}`);
}
