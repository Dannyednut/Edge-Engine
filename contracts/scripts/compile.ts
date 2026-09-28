/**
 * Compile AgentVault.sol to ABI + bytecode using solc (npm package).
 *
 * Output: contracts/build/AgentVault.json
 *
 * Usage: pnpm --filter @edge/contracts compile
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');

const CONTRACTS_DIR = resolve(REPO_ROOT, 'contracts', 'src');
const OZ_DIR        = resolve(REPO_ROOT, 'node_modules', '@openzeppelin');
const BUILD_DIR     = resolve(REPO_ROOT, 'contracts', 'build');

async function main() {
  mkdirSync(BUILD_DIR, { recursive: true });

  const sourcePath = resolve(CONTRACTS_DIR, 'AgentVault.sol');
  const source = readFileSync(sourcePath, 'utf8');

  // Build the solc input (ImportCallback resolves @openzeppelin/* paths)
  const input = {
    language: 'Solidity',
    sources: {
      'AgentVault.sol': { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode'] } },
    },
  };

  console.log('Compiling AgentVault.sol with solc', solc.version());

  const importCallback = (path: string) => {
    if (path.startsWith('@openzeppelin/')) {
      const fullPath = resolve(OZ_DIR, path.slice('@openzeppelin/'.length));
      return { contents: readFileSync(fullPath, 'utf8') };
    }
    if (path.startsWith('./') || path.startsWith('../')) {
      return { contents: readFileSync(resolve(CONTRACTS_DIR, path), 'utf8') };
    }
    return { error: `Unknown import: ${path}` };
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: importCallback }));

  if (output.errors) {
    for (const err of output.errors) {
      if (err.severity === 'error') {
        console.error('X', err.formattedMessage);
      } else {
        console.warn('!', err.formattedMessage);
      }
    }
    const hasErrors = output.errors.some((e: { severity: string }) => e.severity === 'error');
    if (hasErrors) {
      console.error('\nCompilation failed.');
      process.exit(1);
    }
  }

  const contract = output.contracts['AgentVault.sol']['AgentVault'];
  const abi = contract.abi;
  const bytecode = '0x' + contract.evm.bytecode.object;

  const outPath = resolve(BUILD_DIR, 'AgentVault.json');
  writeFileSync(outPath, JSON.stringify({ abi, bytecode, name: 'AgentVault' }, null, 2));
  console.log(`Compiled. ABI: ${abi.length} entries, bytecode: ${bytecode.length} chars`);
  console.log(`  Output: ${outPath}`);

  // Also write ABI-only file for easy importing
  const abiPath = resolve(BUILD_DIR, 'AgentVault.abi.json');
  writeFileSync(abiPath, JSON.stringify(abi, null, 2));
  console.log(`  ABI: ${abiPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
