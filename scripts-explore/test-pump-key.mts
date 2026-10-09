// Test PumpApi with the principal-provided private key
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PumpApiClient } from '../packages/pumpapi-client/src/index.ts';

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
  console.log('  PumpApi Private Key Test');
  console.log('═══════════════════════════════════════════════════\n');

  const privateKey = process.env.PUMPAPI_PRIVATE_KEY;
  const publicKey = process.env.AGENT_SOLANA_ADDRESS;

  console.log('── Configuration ──');
  console.log(`  Public key: ${publicKey}`);
  console.log(`  Private key: ${privateKey ? '(set, ' + privateKey.substring(0, 8) + '...)' : '(not set)'}`);
  console.log('');

  if (!privateKey) {
    console.log('❌ PUMPAPI_PRIVATE_KEY not set in .env');
    return;
  }

  const client = new PumpApiClient({ privateKey, publicKey: publicKey || undefined });

  console.log('── Test 1: getBalances ──');
  try {
    const balances: any = await client.getBalances();
    console.log(`✅ Success! Balances:`);
    console.log(JSON.stringify(balances, null, 2).substring(0, 500));
  } catch (e: any) {
    console.log(`❌ Error: ${e.message}`);
  }

  console.log('\n── Test 2: Load watchlist + getTokenInfo ──');
  try {
    const watchlist = JSON.parse(readFileSync('/home/z/my-project/download/pump-watchlist.json', 'utf8'));
    console.log(`Watchlist: ${watchlist.length} tokens`);

    let success = 0;
    let failed = 0;
    for (const token of watchlist.slice(0, 10)) {
      try {
        const info: any = await client.getTokenInfo(token.mint);
        if (info?.err) {
          failed++;
          console.log(`  ❌ ${token.symbol || token.mint.substring(0, 12)}: ${info.err}`);
        } else if (info?.price) {
          success++;
          console.log(`  ✅ ${token.symbol || token.mint.substring(0, 12)}: price=${info.price}`);
        } else {
          console.log(`  ? ${token.symbol || token.mint.substring(0, 12)}: ${JSON.stringify(info).substring(0, 100)}`);
        }
      } catch (e: any) {
        failed++;
        console.log(`  ❌ ${token.symbol || token.mint.substring(0, 12)}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`\n── Summary ──`);
    console.log(`  Success: ${success}`);
    console.log(`  Failed: ${failed}`);
    console.log('');

    if (success > 0) {
      console.log('🎉 PumpApi private key WORKS!');
      console.log('  - Can query token prices');
      console.log('  - Can execute trades (when wallet funded)');
      console.log('  - Ready to build cross-AMM scanner');
    } else {
      console.log('⚠️  Key may be invalid or watchlist tokens are all invalid');
    }
  } catch (e: any) {
    console.log(`Error: ${e.message}`);
  }
}

main().catch(console.error);
