import { HyperLendClient } from '../packages/executor/src/hyperlend-client.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

async function main() {
  console.log('── HyperLend Lending Rates ──\n');
  try {
    const client = new HyperLendClient({ rpcUrl: 'https://rpc.hyperliquid.xyz/evm' });
    const markets = await client.getMarkets();
    console.log(`Found ${markets.length} markets\n`);
    console.log('Asset       | Supply APY | Borrow APY | Total Supply | Total Borrow | Utilization');
    console.log('────────────|────────────|────────────|──────────────|──────────────|────────────');
    for (const m of markets.sort((a: any, b: any) => (b.supplyAPY || 0) - (a.supplyAPY || 0))) {
      const util = m.totalBorrow > 0 && m.totalSupply > 0 ? (m.totalBorrow / m.totalSupply * 100) : 0;
      console.log(`${(m.assetSymbol || '?').padEnd(12)}| ${(m.supplyAPY || 0).toFixed(2).padStart(9)}%| ${(m.borrowAPY || 0).toFixed(2).padStart(9)}%| ${(m.totalSupply || '0').padStart(12)}| ${(m.totalBorrow || '0').padStart(12)}| ${util.toFixed(1).padStart(10)}%`);
    }
  } catch (e: any) {
    console.log('Error:', e.message?.substring(0, 200));
  }
}
main().catch(console.error);
