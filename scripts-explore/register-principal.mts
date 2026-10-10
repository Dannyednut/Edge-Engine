// Register principal as first client
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerClient } from '../packages/enterprise/src/client/client-manager.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname);

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const principal = registerClient({
  tier: 'principal',
  name: 'Principal',
  telegramId: '5068957503',
  walletAddress: process.env.PRINCIPAL_EVM_ADDRESS,
  notes: 'Enterprise owner — full access to all strategies',
});

console.log('Principal registered:', JSON.stringify(principal, null, 2));
