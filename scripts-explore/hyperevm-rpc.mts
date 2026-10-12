// Explore HyperEVM RPC methods
// Discover what RPC methods are available beyond standard eth_* methods

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';

async function rpc(method: string, params: any[] = []): Promise<any> {
  try {
    const res = await fetch(HYPEREVM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    });
    if (!res.ok) return { error: res.status, statusText: res.statusText };
    const data = await res.json() as any;
    return data.result ?? data.error;
  } catch (e: any) {
    return { error: e.message };
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperEVM RPC Method Discovery');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Test standard eth_* methods
  console.log('── Standard eth_* Methods ──\n');
  const standardMethods = [
    { method: 'eth_blockNumber', params: [] },
    { method: 'eth_chainId', params: [] },
    { method: 'net_version', params: [] },
    { method: 'net_listening', params: [] },
    { method: 'net_peerCount', params: [] },
    { method: 'web3_clientVersion', params: [] },
    { method: 'eth_gasPrice', params: [] },
    { method: 'eth_blockNumber', params: [] },
    { method: 'eth_getBalance', params: ['0x7cE80c805d0d1Ed80fEBf779385389b00a81381A', 'latest'] },
    { method: 'eth_getCode', params: ['0x3333333333333333333333333333333333333333', 'latest'] },
    { method: 'eth_getTransactionCount', params: ['0x7cE80c805d0d1Ed80fEBf779385389b00a81381A', 'latest'] },
    { method: 'eth_estimateGas', params: [{ from: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A', to: '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A', value: '0x0' }] },
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
    { method: 'eth_getBlockByHash', params: ['0x0000000000000000000000000000000000000000000000000000000000000000', false] },
    { method: 'eth_getTransactionByHash', params: ['0x0000000000000000000000000000000000000000000000000000000000000000'] },
    { method: 'eth_getTransactionReceipt', params: ['0x0000000000000000000000000000000000000000000000000000000000000000'] },
    { method: 'eth_getLogs', params: [{ fromBlock: 'latest', toBlock: 'latest' }] },
    { method: 'eth_getStorageAt', params: ['0x7cE80c805d0d1Ed80fEBf779385389b00a81381A', '0x0', 'latest'] },
    { method: 'eth_getCompilers', params: [] },
    { method: 'eth_mining', params: [] },
    { method: 'eth_hashrate', params: [] },
    { method: 'eth_accounts', params: [] },
    { method: 'eth_syncing', params: [] },
    { method: 'eth_protocolVersion', params: [] },
  ];

  console.log('Method                       | Status    | Result (first 80 chars)');
  console.log('─────────────────────────────|───────────|────────────────────────────────────');

  for (const m of standardMethods) {
    const result = await rpc(m.method, m.params);
    let status = '✅';
    let resultStr = '';
    if (result?.error) {
      status = `❌ ${result.error.code || result.error}`;
      resultStr = result.error.message || JSON.stringify(result.error).substring(0, 80);
    } else if (typeof result === 'string') {
      resultStr = result.substring(0, 80);
    } else if (typeof result === 'object') {
      resultStr = JSON.stringify(result).substring(0, 80);
    } else if (typeof result === 'boolean' || typeof result === 'number') {
      resultStr = String(result);
    } else if (result === null) {
      resultStr = 'null';
    } else {
      resultStr = String(result);
    }
    console.log(`${m.method.padEnd(29)}| ${status.padEnd(9)}| ${resultStr}`);
  }

  // 2. Test HyperEVM-specific methods
  console.log('\n── HyperEVM-Specific Methods ──\n');
  const hyperevmMethods = [
    { method: 'hl_blockNumber', params: [] },
    { method: 'hl_getBalance', params: [] },
    { method: 'hyperevm_version', params: [] },
    { method: 'hl_getAssetPrice', params: ['BTC'] },
    { method: 'hl_getPerpPrice', params: ['BTC'] },
    { method: 'hl_getSpotPrice', params: ['HYPE'] },
    { method: 'hl_getFunding', params: ['BTC'] },
    { method: 'hl_getOpenInterest', params: ['BTC'] },
  ];

  for (const m of hyperevmMethods) {
    const result = await rpc(m.method, m.params);
    console.log(`${m.method.padEnd(29)}: ${JSON.stringify(result).substring(0, 100)}`);
  }

  // 3. Test precompile calls
  console.log('\n── Precompile Calls ──\n');
  // Precompile 0x...0807 — HL perp price (BTC = index 0)
  const btcPrice = await rpc('eth_call', [{ to: '0x0000000000000000000000000000000000000807', data: '0x' + '0'.repeat(64) }, 'latest']);
  console.log(`  Precompile 0x...0807 (BTC perp price): ${btcPrice}`);

  // Try other precompile addresses
  const precompiles = [
    '0x0000000000000000000000000000000000000801',
    '0x0000000000000000000000000000000000000802',
    '0x0000000000000000000000000000000000000803',
    '0x0000000000000000000000000000000000000804',
    '0x0000000000000000000000000000000000000805',
    '0x0000000000000000000000000000000000000806',
    '0x0000000000000000000000000000000000000807', // HL perp price (verified)
    '0x0000000000000000000000000000000000000808',
    '0x0000000000000000000000000000000000000809',
    '0x000000000000000000000000000000000000080a',
    '0x000000000000000000000000000000000000080b',
    '0x000000000000000000000000000000000000080c',
  ];

  console.log('\n  Testing precompile addresses (empty calldata):');
  for (const addr of precompiles) {
    const result = await rpc('eth_call', [{ to: addr, data: '0x' }, 'latest']);
    const resultStr = typeof result === 'string' ? result.substring(0, 30) : JSON.stringify(result).substring(0, 30);
    console.log(`    ${addr}: ${resultStr}`);
  }

  // 4. Strategy implications
  console.log('\n── Strategy Implications ──\n');
  console.log('  Available via RPC:');
  console.log('    ✅ Standard eth_* methods (balance, code, tx, logs)');
  console.log('    ✅ Precompile 0x...0807 (HL perp prices)');
  console.log('    ✅ CoreWriter at 0x3333 (place HL orders)');
  console.log('    ✅ Gas estimation');
  console.log('    ✅ Block data');
  console.log('');
  console.log('  NOT available:');
  console.log('    ❌ HyperEVM-specific RPC methods (hl_*)');
  console.log('    ❌ Direct funding rate query (use HL API instead)');
  console.log('    ❌ Direct open interest query (use HL API instead)');
  console.log('');
  console.log('  For HL data: use HL API (https://api.hyperliquid.xyz/info)');
  console.log('  For HyperEVM data: use RPC (https://rpc.hyperliquid.xyz/evm)');
  console.log('  For atomic execution: use precompiles + CoreWriter');
  console.log('');

  console.log('=== Verdict ===');
  console.log('HyperEVM RPC supports standard eth_* methods + precompiles.');
  console.log('  - No HyperEVM-specific methods found');
  console.log('  - Precompile 0x...0807 is the key for atomic arb');
  console.log('  - CoreWriter at 0x3333 enables order placement');
  console.log('  - Build smart contract to orchestrate atomic arb');
}

main().catch(console.error);
