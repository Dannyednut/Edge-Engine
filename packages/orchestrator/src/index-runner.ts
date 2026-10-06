/**
 * Orchestrator entry point — the MANAGER (me) + 5 worker agents.
 *
 * Architecture (corrected per principal feedback):
 *   - I (the orchestrator / main agent) am the MANAGER. I do research myself
 *     (web search, read papers, evaluate tools, think about strategy). This
 *     is NOT a code loop — it is me actually working.
 *   - When I discover something worth building, I assign a TASK to EngineeringAgent.
 *   - When I find a new edge to monitor, I assign a TASK to MonitoringAgent.
 *   - When I decide on capital allocation, I assign a TASK to EconomicsAgent.
 *   - The 5 sub-agents are my WORKERS. They do not initiate. I do.
 *
 * The 5 worker agents:
 *   1. EngineeringAgent   — builds modules when I assign tasks
 *   2. MonitoringAgent    — scans known edges when I assign tasks
 *   3. ExecutionAgent     — executes trades when I assign tasks
 *   4. EconomicsAgent     — manages capital when I assign tasks
 *   5. OperationsAgent    — handles infra when I assign tasks
 *
 * Research is NOT a separate agent. Research is MY job. I am the manager.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Orchestrator, MessageBus } from './index.js';
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
  console.log('  Edge-Engine — Manager + 5 Worker Agents');
  console.log('  (I am the manager. I research. I dispatch. They execute.)');
  console.log('═══════════════════════════════════════════════════\n');

  const messageBus = new MessageBus({ dbPath: 'data/agent-messages.sqlite' });

  const agents = [
    new EngineeringAgent(messageBus),
    new MonitoringAgent(messageBus, process.env.SHARPE_API_KEY, process.env.VOOI_API_TOKEN),
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
    console.log('\n[manager] worker status:');
    for (const s of status) {
      console.log(`  ${s.agentId.padEnd(15)} ${s.status.padEnd(10)} ${s.currentTask ? 'task: ' + s.currentTask : ''}`);
    }
  }, 60_000);

  console.log('\n[manager] running. I research, I dispatch, workers execute. Press Ctrl+C to stop.');
}

main().catch(err => { console.error(err); process.exit(1); });

