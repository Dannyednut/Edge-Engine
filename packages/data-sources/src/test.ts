/**
 * Quick RPC connectivity test — pings every configured chain.
 *
 * Usage: pnpm --filter @edge/data-sources test
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from '@edge/config';
import { buildEvmAdapters, healthCheckAll } from './index.js';

// Resolve repo root
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

// Load .env
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch { /* .env not present */ }

async function main() {
  const cfg = loadConfig(REPO_ROOT);
  console.log('── EVM RPC Connectivity Test ────────────────────');
  const registry = buildEvmAdapters(cfg);
  console.log(`Built ${Object.keys(registry.adapters).length} adapters`);

  const results = await healthCheckAll(registry);
  for (const r of results) {
    const status = r.ok ? '✓' : '✗';
    console.log(`${status} ${r.chainId.padEnd(10)}  block=${r.blockNumber.padStart(12)}  latency=${r.latencyMs}ms`);
  }

  // Solana test (Helius)
  console.log('── Solana RPC Connectivity Test ──────────────────');
  const solRpc = cfg.chains.solana?.rpcHttp;
  if (!solRpc) {
    console.log('✗ solana       not configured');
  } else {
    try {
      const start = Date.now();
      const res = await fetch(solRpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      });
      const json = await res.json() as { result: number };
      console.log(`✓ solana       slot=${String(json.result).padStart(12)}  latency=${Date.now() - start}ms`);
    } catch (err) {
      console.log(`✗ solana       ${err}`);
    }
  }
  console.log('── Done ──────────────────────────────────────────');
}

main().catch(err => { console.error(err); process.exit(1); });
