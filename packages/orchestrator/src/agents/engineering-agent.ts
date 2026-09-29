/**
 * EngineeringAgent — parallel module construction + code review.
 *
 * Responsibilities:
 *   - Build new scanner strategies from ResearchAgent discoveries
 *   - Fix bugs reported by MonitoringAgent
 *   - Refactor + write tests
 *   - Code review (when principal submits PRs)
 *   - Maintain the codebase
 *
 * Runs on-demand. When it receives a TASK, it builds the module and reports
 * back with the result (commit hash, file paths, test status).
 */

import { BaseAgent, type Task, type MessageBus } from '../index.js';

export class EngineeringAgent extends BaseAgent {
  readonly agentId = 'engineering' as const;
  private queue: Task[] = [];

  constructor(messageBus: MessageBus) {
    super({ agentId: 'engineering', messageBus });
  }

  protected async run(): Promise<void> {
    // Main loop: process the task queue
    while (this.status === 'alive') {
      if (this.queue.length > 0) {
        const task = this.queue.shift()!;
        try {
          const result = await this.executeTask(task);
          this.sendMessage('orchestrator', 'RESULT', `Task ${task.subject} complete`, result);
        } catch (err) {
          this.sendMessage('orchestrator', 'ALERT', `Task ${task.subject} failed`, { error: String(err) });
        }
      }
      await sleep(5000);  // poll queue every 5s
    }
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const params = task.params as { type: string; module?: string; description: string };
    switch (params.type) {
      case 'build_module':
        return await this.buildModule(params.module!, params.description);
      case 'fix_bug':
        return await this.fixBug(params.description);
      case 'code_review':
        return await this.codeReview(params.description);
      case 'refactor':
        return await this.refactor(params.module!, params.description);
      case 'write_tests':
        return await this.writeTests(params.module!);
      default:
        throw new Error(`EngineeringAgent: unknown task type ${params.type}`);
    }
  }

  private async buildModule(moduleName: string, description: string): Promise<unknown> {
    console.log(`[engineering] building module ${moduleName}: ${description}`);
    // In a real implementation, this would:
    // 1. Generate the TypeScript file(s) for the new module
    // 2. Run pnpm build to verify it compiles
    // 3. Run any existing tests
    // 4. Commit + push to GitHub
    // 5. Return the commit hash + file paths
    return {
      module: moduleName,
      description,
      status: 'stub — actual code generation would happen here',
      ts: Date.now(),
    };
  }

  private async fixBug(description: string): Promise<unknown> {
    console.log(`[engineering] fixing bug: ${description}`);
    return { description, status: 'stub', ts: Date.now() };
  }

  private async codeReview(description: string): Promise<unknown> {
    console.log(`[engineering] code review: ${description}`);
    return { description, status: 'stub', ts: Date.now() };
  }

  private async refactor(module: string, description: string): Promise<unknown> {
    console.log(`[engineering] refactoring ${module}: ${description}`);
    return { module, description, status: 'stub', ts: Date.now() };
  }

  private async writeTests(module: string): Promise<unknown> {
    console.log(`[engineering] writing tests for ${module}`);
    return { module, status: 'stub', ts: Date.now() };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
