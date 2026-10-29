import { EulerClient } from '../packages/executor/src/euler-client.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

async function main() {
  console.log('── Euler V2 Vault Yields ──\n');
  try {
    const euler = new EulerClient({ rpcUrl: 'https://rpc.hyperliquid.xyz/evm' });
    const vaults = await euler.getAllVaults();
    console.log(`Found ${vaults.length} vaults\n`);

    const sorted = vaults.sort((a: any, b: any) => (b.apyPct || 0) - (a.apyPct || 0));
    console.log('Asset       | APY%   | TotalAssets         | Borrow APY% | Type');
    console.log('────────────|────────|─────────────────────|─────────────|─────────');
    for (const v of sorted.slice(0, 20)) {
      console.log(`${(v.assetSymbol || '?').padEnd(12)}| ${(v.apyPct || 0).toFixed(2).padStart(6)}| ${(v.totalAssets || '0').padStart(20)}| ${(v.borrowApyPct || 0).toFixed(2).padStart(11)}| ${v.type || '?'}`);
    }

    // Find rate spread arbs
    console.log('\n── Rate Spread Arb Opportunities ──\n');
    const supplyVaults = sorted.filter((v: any) => v.apyPct > 0);
    const borrowVaults = sorted.filter((v: any) => v.borrowApyPct > 0);

    for (const s of supplyVaults.slice(0, 5)) {
      for (const b of borrowVaults.slice(0, 5)) {
        if (s.assetSymbol === b.assetSymbol) continue;
        const spread = s.apyPct - b.borrowApyPct;
        if (spread > 1) {
          console.log(`  Supply ${s.assetSymbol} (${s.apyPct.toFixed(2)}%) → Borrow ${b.assetSymbol} (${b.borrowApyPct.toFixed(2)}%) = ${spread.toFixed(2)}% spread`);
          console.log(`    On $5k: $${(5000 * spread / 100).toFixed(0)}/yr`);
        }
      }
    }
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }
}
main().catch(console.error);
