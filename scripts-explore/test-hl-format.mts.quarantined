import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { secp256k1 } from '/home/z/my-project/edge-engine/node_modules/.pnpm/@noble+curves@2.2.0/node_modules/@noble/curves/secp256k1.js';
import { keccak_256 } from '/home/z/my-project/edge-engine/node_modules/.pnpm/@noble+hashes@2.2.0/node_modules/@noble/hashes/sha3.js';

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

const HL_EXCHANGE = 'https://api.hyperliquid.xyz/exchange';
const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY!;
const agentAddress = process.env.AGENT_EVM_ADDRESS!;

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
  return bytes;
}

// Try different body formats
const nonce = Date.now();

// Format 1: Standard (what we tried)
const body1 = {
  chain: '1',
  action: {
    type: 'usdSend',
    to: agentAddress,
    amount: '0.01',
    nonce,
  },
  signature: { r: '0x' + '0'.repeat(64), s: '0x' + '0'.repeat(64), v: 27 },
};

// Format 2: Maybe nonce is separate
const body2 = {
  chain: '1',
  action: {
    type: 'usdSend',
    to: agentAddress,
    amount: '0.01',
  },
  nonce,
  signature: { r: '0x' + '0'.repeat(64), s: '0x' + '0'.repeat(64), v: 27 },
};

// Format 3: Maybe "hyperliquid" chain
const body3 = {
  chain: '1',
  action: {
    type: 'usdSend',
    to: agentAddress.toLowerCase(),
    amount: '0.01',
    nonce,
  },
  signature: { r: '0x' + '0'.repeat(64), s: '0x' + '0'.repeat(64), v: 27 },
};

// Format 4: Maybe "usdClassTransfer" instead
const body4 = {
  chain: '1',
  action: {
    type: 'usdClassTransfer',
    to: 'perp',
    amount: '0.01',
    nonce,
  },
  signature: { r: '0x' + '0'.repeat(64), s: '0x' + '0'.repeat(64), v: 27 },
};

// Format 5: Maybe the action needs "vaultAddress" or other fields
// Let's try a simple "agent" action type
const body5 = {
  chain: '1',
  action: {
    type: 'agent',
    nonce,
  },
  signature: { r: '0x' + '0'.repeat(64), s: '0x' + '0'.repeat(64), v: 27 },
};

async function tryFormat(name: string, body: any) {
  try {
    const res = await fetch(HL_EXCHANGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`${name}: ${res.status} - ${text.substring(0, 200)}`);
  } catch (e: any) {
    console.log(`${name}: Error - ${e.message}`);
  }
}

console.log('Testing different body formats...\n');
await tryFormat('Format 1 (standard)', body1);
await tryFormat('Format 2 (nonce outside)', body2);
await tryFormat('Format 3 (lowercase addr)', body3);
await tryFormat('Format 4 (usdClassTransfer)', body4);
await tryFormat('Format 5 (agent type)', body5);
