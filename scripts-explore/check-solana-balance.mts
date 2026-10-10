import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PumpApiClient } from '../packages/pumpapi-client/src/index.ts';

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
  console.log('── Solana Wallet Balance Check ──\n');
  
  const privateKey = process.env.PUMPAPI_PRIVATE_KEY;
  const publicKey = process.env.AGENT_SOLANA_ADDRESS;
  
  if (!privateKey || !publicKey) {
    console.log('❌ Solana wallet not configured');
    return;
  }
  
  console.log(`Address: ${publicKey}`);
  
  const client = new PumpApiClient({ privateKey, publicKey });
  
  try {
    const balances: any = await client.getBalances();
    console.log('Balances:', JSON.stringify(balances, null, 2));
    
    if (balances?.err) {
      if (balances.err.includes('Insufficient SOL')) {
        console.log('\n❌ Wallet is EMPTY — needs SOL funding');
        console.log('   Need: at least 0.00001 SOL (10,000 lamports) for fees');
        console.log('   Recommended: 0.5 SOL (~$80) for full strategy');
      } else {
        console.log(`\n⚠️  Error: ${balances.err}`);
      }
    } else if (balances?.balances) {
      console.log('\n✅ Wallet has balance!');
      for (const b of balances.balances) {
        console.log(`  ${b.mint}: ${b.amount}`);
      }
    }
  } catch (e: any) {
    console.log('Error:', e.message);
  }
}

main().catch(console.error);
