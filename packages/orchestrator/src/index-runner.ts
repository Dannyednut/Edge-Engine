/**
 * Orchestrator entry point — spawns all 6 department agents + monitors them.
 *
 * Usage: pnpm --filter @edge/orchestrator start
 *
 * In production (on principal's server): runs 24/7, spawns all agents.
 * In sandbox: can be run standalone to verify the architecture compiles
 * and the message bus works. Long-running agents won't survive sandbox
 * process kills — each agent can also be run individually via its npm script.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Orchestrator, MessageBus } from './index.js';
import { ResearchAgent } from './agents/research-agent.js';
import { EngineeringAgent } from './agents/engineering-agent.js';
import { MonitoringAgent } from './agents/monitoring-agent.js';
import { ExecutionAgent } from './agents/execution-agent.js';
import { EconomicsAgent } from './agents/economics-agent.js';
import { OperationsAgent } from './agents/operations-agent.js';

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
  console.log('═══════════════════════════════════════════════════');
  console.log('  Edge-Engine Orchestrator — 6 Department Agents');
  console.log('═══════════════════════════════════════════════════\n');

  const messageBus = new MessageBus({ dbPath: 'data/agent-messages.sqlite' });

  const agents = [
    new ResearchAgent(messageBus, process.env.SHARPE_API_KEY, process.env.VOOI_API_TOKEN),
    new EngineeringAgent(messageBus),
    new MonitoringAgent(messageBus),
    new ExecutionAgent(messageBus),
    new EconomicsAgent(messageBus),
    new OperationsAgent(messageBus),
  ];

  const orchestrator = new Orchestrator({ messageBus, agents });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[orchestrator] SIGINT — shutting down...');
    await orchestrator.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    console.log('\n[orchestrator] SIGTERM — shutting down...');
    await orchestrator.stop();
    process.exit(0);
  });

  await orchestrator.start();

  // Print status every 60s
  setInterval(() => {
    const status = orchestrator.getStatus();
    console.log('\n[orchestrator] agent status:');
    for (const s of status) {
      console.log(`  ${s.agentId.padEnd(15)} ${s.status.padEnd(10)} ${s.currentTask ? 'task: ' + s.currentTask : ''}`);
    }
  }, 60_000);

  // Keep the process alive
  console.log('\n[orchestrator] running. Press Ctrl+C to stop.');
}

main().catch(err => { console.error(err); process.exit(1); });
