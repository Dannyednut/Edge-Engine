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
  const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY!;
  console.log('Private key:', agentPrivateKey.substring(0, 15));
  console.log('Type:', typeof agentPrivateKey);

  // The SDK might expect a different wallet format
  // Let's try different approaches

  // Approach 1: raw hex string
  console.log('\n── Approach 1: raw hex string ──');
  try {
    const transport = new HttpTransport({ requestTimeoutMs: 10_000 });
    const client = new ExchangeClient({
      transport,
      wallet: agentPrivateKey,
      isTestnet: false,
    } as any);
    // Try a simple action
    const result = await client.approveBuilderFee({
      maxFeeRate: '10%' as any,
      builder: process.env.AGENT_EVM_ADDRESS!,
    });
    console.log('Result:', JSON.stringify(result));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }

  // Approach 2: without 0x prefix
  console.log('\n── Approach 2: without 0x prefix ──');
  try {
    const transport = new HttpTransport({ requestTimeoutMs: 10_000 });
    const client = new ExchangeClient({
      transport,
      wallet: agentPrivateKey.replace('0x', ''),
      isTestnet: false,
    } as any);
    const result = await client.approveBuilderFee({
      maxFeeRate: '10%' as any,
      builder: process.env.AGENT_EVM_ADDRESS!,
    });
    console.log('Result:', JSON.stringify(result));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }

  // Approach 3: as bytes
  console.log('\n── Approach 3: as Uint8Array ──');
  try {
    const hex = agentPrivateKey.replace('0x', '');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    const transport = new HttpTransport({ requestTimeoutMs: 10_000 });
    const client = new ExchangeClient({
      transport,
      wallet: bytes,
      isTestnet: false,
    } as any);
    const result = await client.approveBuilderFee({
      maxFeeRate: '10%' as any,
      builder: process.env.AGENT_EVM_ADDRESS!,
    });
    console.log('Result:', JSON.stringify(result));
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }

  // Approach 4: Check SDK docs for wallet type
  console.log('\n── Checking SDK types ──');
  const sdk = await import('@nktkas/hyperliquid');
  // Check ExchangeClient constructor
  console.log('ExchangeClient:', typeof sdk.ExchangeClient);
}

main().catch(console.error);
