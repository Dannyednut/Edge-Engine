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
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL SDK with viem wallet — LIVE SIGNING TEST');
  console.log('═══════════════════════════════════════════════════\n');

  const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY as `0x${string}`;
  const agentAddress = process.env.AGENT_EVM_ADDRESS!;

  // Create wallet using viem
  const wallet = privateKeyToAccount(agentPrivateKey);
  console.log(`  Wallet address: ${wallet.address}`);
  console.log(`  Configured:     ${agentAddress}`);
  console.log(`  Match: ${wallet.address.toLowerCase() === agentAddress.toLowerCase() ? '✅' : '❌'}\n`);

  const transport = new HttpTransport({ requestTimeoutMs: 10_000 });
  const exchClient = new ExchangeClient({
    transport,
    wallet,
    isTestnet: false,
  });

  // Test 1: ApproveBuilderFee
  console.log('── Test 1: ApproveBuilderFee ──\n');
  try {
    const result = await exchClient.approveBuilderFee({
      maxFeeRate: '10%' as any,
      builder: agentAddress,
    });
    console.log('✅ Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 300));
  }

  // Test 2: USD Send (to self)
  console.log('\n── Test 2: USD Send ──\n');
  try {
    const result = await exchClient.usdSend({
      destination: agentAddress,
      amount: '0.01',
    } as any);
    console.log('✅ Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 300));
  }

  // Test 3: noop (simplest action — just tests signing)
  console.log('\n── Test 3: Noop (signing test) ──\n');
  try {
    const result = await (exchClient as any).noop({});
    console.log('✅ Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 300));
  }

  console.log('\n=== Analysis ===');
  console.log('If we get "insufficient balance" → SIGNING WORKS! Just need funds');
  console.log('If we get "ok" or "default" response → FULLY WORKING!');
}

main().catch(console.error);
