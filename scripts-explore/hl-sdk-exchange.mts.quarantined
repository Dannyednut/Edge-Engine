import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

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
  console.log('  HL SDK Exchange Client Test');
  console.log('═══════════════════════════════════════════════════\n');

  const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY;
  const agentAddress = process.env.AGENT_EVM_ADDRESS;

  if (!agentPrivateKey || !agentAddress) {
    console.log('❌ Agent wallet not configured');
    return;
  }

  console.log(`  Address: ${agentAddress}`);
  console.log(`  Private key: ${agentPrivateKey.substring(0, 10)}...\n`);

  // Create ExchangeClient
  const transport = new HttpTransport({ requestTimeoutMs: 10_000 });
  const exchClient = new ExchangeClient({
    transport,
    wallet: agentPrivateKey as any,
    isTestnet: false,
  });

  console.log('── Test 1: ApproveBuilderFee ──\n');
  try {
    const result = await exchClient.approveBuilderFee({
      maxFeeRate: '10', // 10 bps = 0.1%
      builder: agentAddress,
    });
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message);
    console.log('Error type:', e.constructor.name);
    if (e.response) console.log('Response:', JSON.stringify(e.response).substring(0, 300));
  }

  console.log('\n── Test 2: USD Send (to self) ──\n');
  try {
    const result = await exchClient.usdSend({
      to: agentAddress,
      amount: '0.01',
    });
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message);
    if (e.response) console.log('Response:', JSON.stringify(e.response).substring(0, 300));
  }

  console.log('\n── Test 3: Place Order (BTC) ──\n');
  try {
    const result = await exchClient.order({
      coin: 'BTC',
      isBuy: true,
      sz: '0.001',
      limitPx: '50000',
      orderType: { limit: { tif: 'Gtc' } },
      reduceOnly: false,
      builder: { b: agentAddress, f: 10 },
    });
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message);
    if (e.response) console.log('Response:', JSON.stringify(e.response).substring(0, 300));
  }

  console.log('\n=== Verdict ===');
  console.log('If we get "insufficient balance" errors, signing is WORKING!');
  console.log('If we get "invalid signature" errors, need to fix wallet format');
}

main().catch(console.error);
