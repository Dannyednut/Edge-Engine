/**
 * Generate the agent's EVM + Solana wallets.
 * Saves private keys to .env (gitignored).
 * Outputs addresses for the principal to fund.
 *
 * Run from repo root: pnpm --filter @edge/data-sources gen:agent-wallets
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require = createRequire(import.meta.url);

// Resolve repo root (3 levels up from packages/data-sources/src/)
// __dirname = .../edge-engine/packages/data-sources/src
// ..        = .../edge-engine/packages/data-sources
// ../..     = .../edge-engine/packages
// ../..​/..  = .../edge-engine  ← REPO_ROOT
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// Solana keypair generation using @noble/curves (already a viem dep, no extra install)
// Fallback: use node:crypto + manual ed25519
function generateSolanaKeypair(): { publicKey: string; secretKey: string } {
  // Use @solana/web3.js if available, otherwise use node:crypto ed25519
  try {
    const { Keypair } = require('@solana/web3.js');
    const kp = Keypair.generate();
    return {
      publicKey: kp.publicKey.toBase58(),
      secretKey: Buffer.from(kp.secretKey).toString('base64'),
    };
  } catch {
    // Manual ed25519 keypair via node:crypto
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    // Export raw 32-byte keys via DER then slice
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const secDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    // SPKI for ed25519 pubkey is 44 bytes total; last 32 are the raw pubkey
    const pubRaw = pubDer.subarray(pubDer.length - 32);
    // PKCS8 for ed25519 secret is 48 bytes total; last 32 are the raw secret
    const secRaw = secDer.subarray(secDer.length - 32);
    // Solana expects 64-byte secret = 32-byte seed + 32-byte pub
    const fullSecret = Buffer.concat([Buffer.from(secRaw), Buffer.from(pubRaw)]);
    return {
      publicKey: encodeBase58(Buffer.from(pubRaw)),
      secretKey: fullSecret.toString('base64'),
    };
  }
}

function encodeBase58(bytes: Buffer | Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  let num = BigInt('0');
  for (let i = 0; i < bytes.length; i++) {
    num = num * 256n + BigInt(bytes[i]);
  }
  while (num > 0n) {
    const rem = num % 58n;
    num = num / 58n;
    result = alphabet[Number(rem)] + result;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    result = '1' + result;
  }
  return result;
}

async function main() {
  const envPath = resolve(REPO_ROOT, '.env');

  // Load existing env
  const env = readFileSync(envPath, 'utf8');

  // ─── EVM agent wallet ────────────────────────────────────────────────
  const evmPk = generatePrivateKey();
  const evmAccount = privateKeyToAccount(evmPk);

  console.log('═══════════════════════════════════════════════════════');
  console.log('  AGENT EVM WALLET GENERATED');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Address:', evmAccount.address);
  console.log('  (Private key saved to .env as AGENT_EVM_PRIVATE_KEY)');
  console.log('');

  // ─── Solana agent wallet ─────────────────────────────────────────────
  const sol = generateSolanaKeypair();
  console.log('═══════════════════════════════════════════════════════');
  console.log('  AGENT SOLANA WALLET GENERATED');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Address:', sol.publicKey);
  console.log('  (Secret key saved to .env as AGENT_SOLANA_PRIVATE_KEY)');
  console.log('');

  // ─── Append to .env (without overwriting existing entries) ──────────
  const additions: string[] = [];
  if (!env.includes('AGENT_EVM_PRIVATE_KEY=')) additions.push(`AGENT_EVM_PRIVATE_KEY=${evmPk}`);
  if (!env.includes('AGENT_EVM_ADDRESS='))     additions.push(`AGENT_EVM_ADDRESS=${evmAccount.address}`);
  if (!env.includes('AGENT_SOLANA_PRIVATE_KEY=')) additions.push(`AGENT_SOLANA_PRIVATE_KEY=${sol.secretKey}`);
  if (!env.includes('AGENT_SOLANA_ADDRESS='))     additions.push(`AGENT_SOLANA_ADDRESS=${sol.publicKey}`);

  if (additions.length > 0) {
    additions.unshift('');
    additions.unshift('# ─── Agent wallets (generated 2026-09-26 by gen-agent-wallets.ts) ───');
    appendFileSync(envPath, additions.join('\n') + '\n');
    console.log(`✓ Appended ${additions.length - 1} entries to .env`);
  } else {
    console.log('  (Agent wallet entries already exist in .env — not overwritten.)');
  }

  console.log('');
  console.log('── Next steps ─────────────────────────────────────────');
  console.log('  1. Fund EVM agent wallet with ~0.05 ETH on Base for gas');
  console.log(`     → Send to: ${evmAccount.address}`);
  console.log('  2. Fund Solana agent wallet with ~0.1 SOL for gas');
  console.log(`     → Send to: ${sol.publicKey}`);
  console.log('  3. Once funded, agent deploys AgentVault.sol (EVM) and');
  console.log('     registers as operator on Squads (Solana).');
  console.log('  4. Principal funds AgentVault with trading capital.');
}

main().catch(err => { console.error(err); process.exit(1); });
