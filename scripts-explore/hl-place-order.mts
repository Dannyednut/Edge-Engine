/**
 * HL Order Placement — LIVE function
 * Uses @nktkas/hyperliquid SDK (signing verified working)
 * 
 * Order format from SDK docs:
 *   orders: [{ a: assetId, b: isBuy, p: limitPx, s: sz, r: reduceOnly, t: orderType, c: cloid }]
 *   grouping: "na"
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { privateKeyToAccount } from '/home/z/my-project/edge-engine/node_modules/.pnpm/viem@2.56.9_bufferutil@4.1.0_typescript@5.9.3/node_modules/viem/accounts';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

async function main() {
  const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY as `0x${string}`;
  const agentAddress = process.env.AGENT_EVM_ADDRESS!;
  const wallet = privateKeyToAccount(agentPrivateKey);
  const transport = new HttpTransport({ requestTimeoutMs: 10_000 });
  const exchClient = new ExchangeClient({ transport, wallet, isTestnet: false });

  // Get asset ID for BTC (need to find it)
  const metaRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  const meta = await metaRes.json();
  const btcIndex = meta.universe.findIndex((u: any) => u.name === 'BTC');
  console.log(`BTC asset ID: ${btcIndex}`);

  // Try to place a small order
  console.log('\nAttempting to place BTC order...');
  try {
    const result = await exchClient.order({
      orders: [{
        a: btcIndex,
        b: true,           // isBuy
        p: '50000',        // limitPx (well below market, won't fill)
        s: '0.001',        // sz
        r: false,          // reduceOnly
        t: { limit: { tif: 'Gtc' } },  // orderType
      }],
      grouping: 'na',
      builder: { b: agentAddress, f: 10 },
    } as any);
    console.log('✅ Order result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 300));
    if (e.message?.includes('deposit') || e.message?.includes('balance')) {
      console.log('\n✅ SIGNING WORKS — just need to fund wallet!');
    }
  }

  // Try approveBuilderFee with correct format
  console.log('\nAttempting approveBuilderFee...');
  try {
    const result = await exchClient.approveBuilderFee({
      maxFeeRate: '0.1%' as any,
      builder: agentAddress,
    });
    console.log('✅ Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 300));
    if (e.message?.includes('deposit') || e.message?.includes('balance')) {
      console.log('\n✅ SIGNING WORKS — just need to fund wallet!');
    }
  }
}

main().catch(console.error);
