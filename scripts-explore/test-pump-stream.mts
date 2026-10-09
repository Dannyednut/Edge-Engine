// Test PumpStreamClient — listen for real-time pump.fun events
// Stream is FREE, no auth required

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PumpStreamClient } from '../packages/pumpapi-client/src/index.ts';

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
  console.log('  PumpApi Stream Test (30 seconds)');
  console.log('═══════════════════════════════════════════════════\n');

  let eventCount = 0;
  const eventTypes: Record<string, number> = {};
  const tokenLaunches: any[] = [];

  const client = new PumpStreamClient({
    onConnect: () => console.log('✅ Connected to PumpApi stream'),
    onDisconnect: (err) => console.log(`⚠️  Disconnected: ${err?.message || 'unknown'}`),
    onEvent: (event) => {
      eventCount++;
      const type = event.type || 'unknown';
      eventTypes[type] = (eventTypes[type] || 0) + 1;

      // Log first 10 events of each type
      if (eventTypes[type] <= 3) {
        console.log(`[${type}] ${JSON.stringify(event).substring(0, 200)}`);
      }

      // Track token launches
      if (type === 'create' || type === 'token_created' || type === 'launch') {
        tokenLaunches.push({
          mint: (event as any).mint,
          symbol: (event as any).symbol,
          name: (event as any).name,
          ts: Date.now(),
        });
      }

      // Print summary every 100 events
      if (eventCount % 100 === 0) {
        console.log(`\n── ${eventCount} events received ──`);
        for (const [t, c] of Object.entries(eventTypes)) {
          console.log(`  ${t}: ${c}`);
        }
        console.log('');
      }
    },
  });

  console.log('Connecting to wss://stream.pumpapi.io/...');
  await client.connect();

  // Listen for 30 seconds
  console.log('Listening for 30 seconds...\n');
  await new Promise(r => setTimeout(r, 30_000));

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Stream Test Complete');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`Total events: ${eventCount}`);
  console.log('\nEvent types:');
  for (const [t, c] of Object.entries(eventTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(30)} ${c}`);
  }
  console.log(`\nToken launches detected: ${tokenLaunches.length}`);
  if (tokenLaunches.length > 0) {
    console.log('First 5 launches:');
    for (const t of tokenLaunches.slice(0, 5)) {
      console.log(`  ${t.symbol || t.mint?.substring(0, 12)}`);
    }
  }

  client.close();
}

main().catch(console.error);
