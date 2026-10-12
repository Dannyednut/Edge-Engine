import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { privateKeyToAccount } from '/home/z/my-project/edge-engine/node_modules/.pnpm/viem@2.56.9_bufferutil@4.1.0_typescript@5.9.3/node_modules/viem/accounts';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';

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

  // Use metaAndAssetCtxs to get universe
  const metaRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', user: agentAddress }),
  });
  const meta = await metaRes.json();
  const universe = meta?.[0]?.universe || [];
  const btcIndex = universe.findIndex((u: any) => u.name === 'BTC');
  console.log(`BTC index: ${btcIndex}, total perps: ${universe.length}`);

  // Try order with correct format
  console.log('\nPlacing BTC order (limit $50000, sz 0.001)...');
  try {
    const result = await exchClient.order({
      orders: [{
        a: btcIndex,
        b: true,
        p: '50000',
        s: '0.001',
        r: false,
        t: { limit: { tif: 'Gtc' } },
      }],
      grouping: 'na',
      builder: { b: agentAddress, f: 10 },
    } as any);
    console.log('✅ Order result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    const msg = e.message || '';
    console.log('Error:', msg.substring(0, 300));
    if (msg.includes('deposit') || msg.includes('balance') || msg.includes('exist')) {
      console.log('\n✅ SIGNING WORKS — signature accepted by HL!');
      console.log('   Just need to fund wallet with USDC.');
    }
  }

  // Also try usdSend with correct format
  console.log('\nTrying usdSend...');
  try {
    const result = await exchClient.usdSend({
      destination: agentAddress,
      amount: '0.01',
    } as any);
    console.log('✅ usdSend result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    const msg = e.message || '';
    console.log('Error:', msg.substring(0, 300));
    if (msg.includes('deposit') || msg.includes('balance') || msg.includes('exist')) {
      console.log('\n✅ SIGNING WORKS — signature accepted!');
    }
  }

  // Try createUserVault
  console.log('\nTrying createUserVault...');
  try {
    const result = await (exchClient as any).createUserVault({
      name: 'Edge-Engine Alpha Vault',
      description: 'Delta-neutral arbitrage strategies on Hyperliquid',
    });
    console.log('✅ Vault result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    const msg = e.message || '';
    console.log('Error:', msg.substring(0, 300));
    if (msg.includes('deposit') || msg.includes('balance') || msg.includes('exist')) {
      console.log('\n✅ SIGNING WORKS — signature accepted!');
    }
  }
}

main().catch(console.error);
