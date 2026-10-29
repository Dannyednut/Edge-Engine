// Register principal as first client
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerClient } from '../packages/enterprise/src/client/client-manager.ts';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname);

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const principal = registerClient({
  tier: 'principal',
  name: 'Principal',
  telegramId: '5068957503',
  walletAddress: process.env.PRINCIPAL_EVM_ADDRESS,
  notes: 'Enterprise owner — full access to all strategies',
});

console.log('Principal registered:', JSON.stringify(principal, null, 2));
