import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL SDK Exchange Client — Fixed Parameters');
  console.log('═══════════════════════════════════════════════════\n');

  const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY!;
  const agentAddress = process.env.AGENT_EVM_ADDRESS!;

  const transport = new HttpTransport({ requestTimeoutMs: 10_000 });
  const exchClient = new ExchangeClient({
    transport,
    wallet: agentPrivateKey as any,
    isTestnet: false,
  });

  // Test 1: ApproveBuilderFee — needs "10%" not "10"
  console.log('── Test 1: ApproveBuilderFee ──\n');
  try {
    const result = await exchClient.approveBuilderFee({
      maxFeeRate: '10%' as any, // SDK expects percentage format
      builder: agentAddress,
    });
    console.log('✅ Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }

  // Test 2: USD Send — needs "destination" not "to"
  console.log('\n── Test 2: USD Send ──\n');
  try {
    const result = await exchClient.usdSend({
      destination: agentAddress,
      amount: '0.01',
    } as any);
    console.log('✅ Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }

  // Test 3: Place Order — needs "orders" array
  console.log('\n── Test 3: Place Order ──\n');
  try {
    const result = await exchClient.order({
      orders: [{
        coin: 'BTC',
        isBuy: true,
        sz: '0.001',
        limitPx: '50000',
        orderType: { limit: { tif: 'Gtc' } },
        reduceOnly: false,
      }],
      builder: { b: agentAddress, f: 10 },
    } as any);
    console.log('✅ Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }

  console.log('\n=== Analysis ===');
  console.log('If errors say "insufficient balance" → SIGNING WORKS!');
  console.log('If errors say "invalid signature" → wallet format issue');
}

main().catch(console.error);
