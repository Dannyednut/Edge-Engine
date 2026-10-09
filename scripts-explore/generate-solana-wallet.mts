// Generate a new Solana wallet for the agent
// Uses crypto.randomBytes for secure key generation
// Solana keypair = 32-byte secret key + 32-byte public key
// Public key = ed25519 public key derived from secret key
// Address = base58-encoded public key

import { randomBytes, createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// Base58 encoding
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Buffer): string {
  let result = '';
  let num = BigInt('0x' + bytes.toString('hex'));
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    result = BASE58_ALPHABET[Number(remainder)] + result;
  }
  // Leading zeros
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result;
    else break;
  }
  return result;
}

// Generate ed25519 keypair using Node's crypto
async function generateSolanaKeypair(): Promise<{ publicKey: string; secretKey: string; secretKeyHex: string }> {
  // Use Node's generateKeyPairSync for ed25519
  const { generateKeyPairSync } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  // Export private key as raw 32-byte seed
  const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  // ed25519 PKCS8 DER has the 32-byte seed at the end
  const seed = privateKeyDer.subarray(-32);

  // Export public key as raw 32 bytes
  const publicKeyRaw = publicKey.export({ type: 'spki', format: 'der' });
  // ed25519 SPKI DER has the 32-byte public key at the end
  const pubKeyBytes = publicKeyRaw.subarray(-32);

  return {
    publicKey: base58Encode(Buffer.from(pubKeyBytes)),
    secretKey: base58Encode(Buffer.from(seed)),
    secretKeyHex: Buffer.from(seed).toString('hex'),
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Agent Solana Wallet Generator');
  console.log('═══════════════════════════════════════════════════\n');

  const keypair = await generateSolanaKeypair();

  console.log('✅ NEW SOLANA WALLET GENERATED\n');
  console.log('── Public Key (wallet address) ──');
  console.log(`  ${keypair.publicKey}`);
  console.log('');
  console.log('── Private Key (base58 — for PumpApi Lightning mode) ──');
  console.log(`  ${keypair.secretKey}`);
  console.log('');
  console.log('── Private Key (hex — backup format) ──');
  console.log(`  ${keypair.secretKeyHex}`);
  console.log('');
  console.log('⚠️  SECURITY WARNINGS:');
  console.log('  1. Save the private key SECURELY (password manager, hardware wallet)');
  console.log('  2. NEVER share the private key with anyone');
  console.log('  3. Anyone with the private key can drain the wallet');
  console.log('  4. Fund this wallet with only what you can afford to lose');
  console.log('  5. For production, use a hardware wallet or multi-sig');
  console.log('');

  // Save to file (for agent to use)
  const walletFile = '/home/z/my-project/download/agent-solana-wallet.json';
  writeFileSync(walletFile, JSON.stringify({
    publicKey: keypair.publicKey,
    privateKey: keypair.secretKey,
    privateKeyHex: keypair.secretKeyHex,
    generatedAt: new Date().toISOString(),
    note: 'Agent Solana wallet for pump.fun delta-neutral arb strategy',
  }, null, 2));
  console.log(`Wallet saved to: ${walletFile}`);
  console.log('');
  console.log('To activate:');
  console.log('  1. Add to .env:');
  console.log(`     AGENT_SOLANA_ADDRESS=${keypair.publicKey}`);
  console.log(`     PUMPAPI_PRIVATE_KEY=${keypair.secretKey}`);
  console.log('  2. Fund the wallet with SOL (start with 0.5 SOL = ~$80)');
  console.log('  3. Set dryRun: false in pump-arb-executor.mts');
  console.log('  4. Test with small trades first');
}

main().catch(console.error);
