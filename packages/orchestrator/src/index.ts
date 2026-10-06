/**
 * @edge/orchestrator — Subagent orchestration layer.
 *
 * Architecture:
 *   The edge-engine operates across 6 functional departments. Each department
 *   runs as an independent subagent with its own event loop, state, and
 *   message queue. The Orchestrator dispatches tasks, monitors health, and
 *   routes inter-agent messages.
 *
 * Departments:
 *   1. ResearchAgent      — continuous edge discovery + market monitoring
 *   2. EngineeringAgent    — parallel module construction + code review
 *   3. MonitoringAgent     — scanner + listener 24/7, anomaly surfacing
 *   4. ExecutionAgent      — live trade execution, position management
 *   5. EconomicsAgent      — capital allocation, P&L tracking, rebalancing
 *   6. OperationsAgent     — deployments, secrets, infra, GitHub, health
 *
 * Message bus:
 *   Agents communicate via a shared message queue (SQLite-backed). Each agent
 *   has an inbox (incoming tasks) and outbox (results + new tasks for other
 *   agents). The Orchestrator routes messages.
 *
 *   Message types:
 *     - TASK:      "do this thing" (from orchestrator or another agent)
 *     - RESULT:    "here's what I found/built/did" (response to a TASK)
 *     - ALERT:     "something happened you should know about"
 *     - HANDOFF:   "I'm done with this, someone else should pick it up"
 *     - STATUS:    periodic heartbeat (alive + current state)
 *
 * Health monitoring:
 *   Each agent sends a STATUS heartbeat every 60s. If an agent misses 3
 *   heartbeats, the Orchestrator marks it DEAD and alerts the principal.
 *
 * Concurrency model:
 *   Each agent runs in its own Node.js process (via child_process.fork).
 *   This gives true parallelism — no agent blocks another. The Orchestrator
 *   is the parent process that spawns + monitors them.
 *
 *   In the sandbox (where we cannot run long-lived processes), each agent
 *   can also run standalone via its npm script (e.g. pnpm --filter
 *   @edge/orchestrator start:research). The principal can run them on their
 *   server in separate tmux panes.
 */

import type { AlertSeverity } from '@edge/types';

// ─── Agent identity ────────────────────────────────────────────────────

export type AgentId =
  | 'orchestrator'
  | 'research'
  | 'engineering'
  | 'monitoring'
  | 'execution'
  | 'economics'
  | 'operations';

export type AgentStatus = 'starting' | 'alive' | 'paused' | 'dead' | 'stopped';

export interface AgentHeartbeat {
  agentId: AgentId;
  status: AgentStatus;
  ts: number;
  currentTask?: string;
  metrics?: Record<string, number>;
}

// ─── Message bus ───────────────────────────────────────────────────────

export type MessageType = 'TASK' | 'RESULT' | 'ALERT' | 'HANDOFF' | 'STATUS';

export interface AgentMessage {
  id: string;
  ts: number;
  from: AgentId;
  to: AgentId | 'broadcast';
  type: MessageType;
  subject: string;
  body: unknown;
  /** ID of the message this is responding to (for RESULT). */
  inReplyTo?: string;
  /** Priority — higher = more urgent. Default 0. */
  priority?: number;
}

// ─── Task definitions ──────────────────────────────────────────────────

export interface Task {
  id: string;
  agentId: AgentId;          // which agent should handle this
  subject: string;
  description: string;
  params?: Record<string, unknown>;
  createdAt: number;
  deadline?: number;         // epoch ms
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'cancelled';
  result?: TaskResult;
  assignedAt?: number;
  completedAt?: number;
}

export interface TaskResult {
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

// ─── Department-specific task types ────────────────────────────────────

export interface ResearchTask extends Task {
  agentId: 'research';
  params: {
    type: 'scan_market' | 'research_edge' | 'monitor_regime' | 'backtest';
    landscape?: string;
    query?: string;
    duration?: number;
  };
}

export interface EngineeringTask extends Task {
  agentId: 'engineering';
  params: {
    type: 'build_module' | 'fix_bug' | 'code_review' | 'refactor' | 'write_tests';
    module?: string;
    description: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
  };
}

export interface MonitoringTask extends Task {
  agentId: 'monitoring';
  params: {
    type: 'start_scanner' | 'stop_scanner' | 'start_listener' | 'stop_listener' | 'health_check';
    strategies?: string[];
  };
}

export interface ExecutionTask extends Task {
  agentId: 'execution';
  params: {
    type: 'execute_arb' | 'close_position' | 'rebalance' | 'emergency_close_all';
    opportunityId?: string;
    positionId?: string;
    reason?: string;
  };
}

export interface EconomicsTask extends Task {
  agentId: 'economics';
  params: {
    type: 'allocate_capital' | 'rebalance' | 'pnl_report' | 'risk_assessment';
    amountUsd?: number;
    landscape?: string;
  };
}

export interface OperationsTask extends Task {
  agentId: 'operations';
  params: {
    type: 'deploy_contract' | 'verify_deployment' | 'rotate_secrets' | 'backup' | 'restore';
    chain?: string;
    contractName?: string;
  };
}

// ─── Agent base class ──────────────────────────────────────────────────

export interface BaseAgentOptions {
  agentId: AgentId;
  messageBus: MessageBus;
  /** Called every 60s to send a heartbeat. */
  onHeartbeat?: (agent: BaseAgent) => AgentHeartbeat;
}

export abstract class BaseAgent {
  readonly agentId: AgentId;
  status: AgentStatus = 'starting';
  protected readonly messageBus: MessageBus;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  protected currentTask?: Task;

  constructor(opts: BaseAgentOptions) {
    this.agentId = opts.agentId;
    this.messageBus = opts.messageBus;
  }

  /** Start the agent's event loop. */
  async start(): Promise<void> {
    this.status = 'alive';
    console.log(`[${this.agentId}] agent started`);

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      const heartbeat: AgentHeartbeat = {
        agentId: this.agentId,
        status: this.status,
        ts: Date.now(),
        currentTask: this.currentTask?.subject,
      };
      this.messageBus.publish({
        id: `hb_${this.agentId}_${Date.now()}`,
        ts: Date.now(),
        from: this.agentId,
        to: 'orchestrator',
        type: 'STATUS',
        subject: 'heartbeat',
        body: heartbeat,
      });
    }, 60_000);

    // Start the agent's main loop
    await this.run();
  }

  /** Stop the agent gracefully. */
  async stop(): Promise<void> {
    this.status = 'stopped';
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    console.log(`[${this.agentId}] agent stopped`);
  }

  /** Subclasses implement this — the agent's main work loop. */
  protected abstract run(): Promise<void>;

  /** Process a task assigned to this agent. */
  async executeTask(task: Task): Promise<TaskResult> {
    this.currentTask = task;
    task.status = 'in_progress';
    task.assignedAt = Date.now();
    const start = Date.now();

    try {
      const output = await this.handleTask(task);
      const result: TaskResult = {
        success: true,
        output,
        durationMs: Date.now() - start,
      };
      task.status = 'done';
      task.result = result;
      task.completedAt = Date.now();
      return result;
    } catch (err) {
      const result: TaskResult = {
        success: false,
        error: String(err),
        durationMs: Date.now() - start,
      };
      task.status = 'failed';
      task.result = result;
      task.completedAt = Date.now();
      return result;
    } finally {
      this.currentTask = undefined;
    }
  }

  /** Subclasses implement this — handle a specific task. */
  protected abstract handleTask(task: Task): Promise<unknown>;

  /** Send a message to another agent. */
  protected sendMessage(to: AgentId | 'broadcast', type: MessageType, subject: string, body: unknown): void {
    this.messageBus.publish({
      id: `msg_${this.agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      from: this.agentId,
      to,
      type,
      subject,
      body,
    });
  }

  /** Send an alert to the principal via Telegram. */
  protected async sendAlert(severity: AlertSeverity, title: string, body: string): Promise<void> {
    this.sendMessage('orchestrator', 'ALERT', title, { severity, body });
  }
}

// ─── Message bus (SQLite-backed) ───────────────────────────────────────

export interface MessageBusOptions {
  dbPath: string;
}

export class MessageBus {
  private messages: AgentMessage[] = [];

  constructor(_opts: MessageBusOptions) {
    // In production this would be SQLite-backed for persistence across
    // process restarts. For now, in-memory (sufficient for single-process
    // orchestrator; for multi-process, swap to SQLite).
  }

  publish(msg: AgentMessage): void {
    this.messages.push(msg);
    console.log(`[MessageBus] ${msg.from} → ${msg.to} ${msg.type}: ${msg.subject}`);
  }

  /** Get all messages for a specific agent, optionally filtered by type. */
  receive(agentId: AgentId, type?: MessageType): AgentMessage[] {
    const matching = this.messages.filter(m =>
      (m.to === agentId || m.to === 'broadcast') &&
      (!type || m.type === type)
    );
    // Remove received messages from the queue
    this.messages = this.messages.filter(m => !matching.includes(m));
    return matching;
  }

  /** Peek without removing (for monitoring). */
  peek(agentId: AgentId, type?: MessageType): AgentMessage[] {
    return this.messages.filter(m =>
      (m.to === agentId || m.to === 'broadcast') &&
      (!type || m.type === type)
    );
  }

  /** Get all messages (for monitoring/debugging). */
  getAll(): AgentMessage[] {
    return [...this.messages];
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────────

export interface OrchestratorOptions {
  messageBus: MessageBus;
  agents: BaseAgent[];
}

export class Orchestrator {
  private readonly messageBus: MessageBus;
  private readonly agents: Map<AgentId, BaseAgent> = new Map();
  private readonly heartbeats: Map<AgentId, AgentHeartbeat> = new Map();

  constructor(opts: OrchestratorOptions) {
    this.messageBus = opts.messageBus;
    for (const agent of opts.agents) {
      this.agents.set(agent.agentId, agent);
    }
  }

  async start(): Promise<void> {
    console.log('[Orchestrator] starting all agents...');

    // Start all agents in parallel
    await Promise.all(
      Array.from(this.agents.values()).map(agent => agent.start().catch(err => {
        console.error(`[Orchestrator] failed to start ${agent.agentId}:`, err);
      }))
    );

    // Start the orchestrator's own loop (heartbeat monitor + message router)
    this.startMonitorLoop();

    console.log('[Orchestrator] all agents started');
  }

  async stop(): Promise<void> {
    console.log('[Orchestrator] stopping all agents...');
    await Promise.all(
      Array.from(this.agents.values()).map(agent => agent.stop().catch(() => {}))
    );
    console.log('[Orchestrator] stopped');
  }

  /** Dispatch a task to a specific agent. */
  dispatchTask(task: Task): void {
    const agent = this.agents.get(task.agentId);
    if (!agent) {
      console.error(`[Orchestrator] no agent for ${task.agentId}`);
      return;
    }
    this.messageBus.publish({
      id: `task_${task.id}_${Date.now()}`,
      ts: Date.now(),
      from: 'orchestrator',
      to: task.agentId,
      type: 'TASK',
      subject: task.subject,
      body: task,
    });
  }

  private startMonitorLoop(): void {
    setInterval(() => {
      // Check heartbeats
      const now = Date.now();
      for (const [agentId, hb] of this.heartbeats.entries()) {
        if (now - hb.ts > 3 * 60_000 && hb.status === 'alive') {
          console.error(`[Orchestrator] AGENT ${agentId} MISSED 3 HEARTBEATS — marking DEAD`);
          hb.status = 'dead';
        }
      }

      // Route messages
      const messages = this.messageBus.getAll();
      for (const msg of messages) {
        if (msg.type === 'STATUS' && msg.to === 'orchestrator') {
          const hb = msg.body as AgentHeartbeat;
          this.heartbeats.set(hb.agentId, hb);
        }
      }
    }, 30_000);
  }

  /** Get the current status of all agents. */
  getStatus(): Array<{ agentId: AgentId; status: AgentStatus; lastHeartbeat?: number; currentTask?: string }> {
    return Array.from(this.agents.keys()).map(agentId => {
      const hb = this.heartbeats.get(agentId);
      return {
        agentId,
        status: hb?.status ?? 'starting',
        lastHeartbeat: hb?.ts,
        currentTask: hb?.currentTask,
      };
    });
  }
}
