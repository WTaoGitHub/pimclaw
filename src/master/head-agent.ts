/**
 * Head Agent - The intelligence center of PimClaw
 * Implements the Observe-Think-Decide loop
 * - Observes Grafana metrics every 5 minutes
 * - Analyzes for anomalies
 * - Decides whether to plan corrective tasks
 */

import { BaseAgent } from './base-agent.js';
import { AgentRegistry } from './agent-registry.js';
import { TaskStatusRecorder } from './task-status-recorder.js';
import { MetricsSnapshot, DetectedEvent, Task } from '../types/index.js';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * Head Agent - Decision Engine
 * Observes LLM metrics, detects anomalies, and plans corrective tasks
 */
export class HeadAgent extends BaseAgent {
  private taskRecorder: TaskStatusRecorder;
  private snapshotInterval: number = 5 * 60 * 1000; // 5 minutes
  private snapshotStalenessMs: number = 60 * 1000; // 1 minute staleness threshold
  private maxSnapshotCopies: number = 5;
  private snapshotHistory: MetricsSnapshot[] = [];
  private storagePath: string = './pimclaw-head-data';
  private isRunning: boolean = false;

  constructor(
    registry: AgentRegistry,
    taskRecorder: TaskStatusRecorder
  ) {
    super('head', registry, {
      agentId: 'head-1',
      agentType: 'head',
      mcpServices: {
        grafana: {
          command: 'node',
          args: ['path/to/grafana-mcp-server.js'],
        },
        perf: {
          command: 'node',
          args: ['path/to/perf-mcp-server.js'],
        },
        simulator: {
          command: 'python',
          args: ['path/to/simulator-mcp-server.py'],
        },
      },
    });
    this.taskRecorder = taskRecorder;
  }

  /**
   * Initialize the Head Agent
   */
  override async initialize(): Promise<void> {
    await super.initialize();
    await this.loadPersistedSnapshots();
    await this.recoverUnprocessedSnapshots();
  }

  /**
   * Load persisted snapshots from storage
   */
  private async loadPersistedSnapshots(): Promise<void> {
    try {
      const snapshotsFile = path.join(this.storagePath, 'snapshots.json');
      const data = await fs.readFile(snapshotsFile, 'utf-8');
      const snapshots = JSON.parse(data) as MetricsSnapshot[];
      this.snapshotHistory = snapshots.slice(-this.maxSnapshotCopies);
    } catch {
      // No file yet, start fresh
      await fs.mkdir(this.storagePath, { recursive: true });
    }
  }

  /**
   * Recover unprocessed snapshots from a previous session
   */
  private async recoverUnprocessedSnapshots(): Promise<void> {
    const now = new Date().getTime();
    for (const snapshot of this.snapshotHistory) {
      const snapshotAge = now - new Date(snapshot.collectedAt).getTime();
      const isStale = snapshotAge > this.snapshotStalenessMs;

      if (!snapshot.analyzed && !isStale) {
        console.log(
          `[Head] Recovering unprocessed snapshot ${snapshot.snapshotId}`
        );
        await this.analyzeSnapshot(snapshot);
      } else if (isStale) {
        snapshot.analyzed = true; // Mark stale snapshots as analyzed without processing
      }
    }
  }

  /**
   * Main Head Agent loop: Observe-Think-Decide
   */
  async run(): Promise<void> {
    this.isRunning = true;
    this.updateAction('Starting Observe-Think-Decide loop');

    while (this.isRunning && this.status === 'Listening') {
      try {
        await this.observeThinkDecideCycle();
        await this.sleep(this.snapshotInterval);
      } catch (error) {
        this.registry.recordError(
          this.agentId,
          `Head loop error: ${error instanceof Error ? error.message : String(error)}`
        );
        await this.sleep(this.snapshotInterval);
      }
    }
  }

  /**
   * Single Observe-Think-Decide cycle
   */
  private async observeThinkDecideCycle(): Promise<void> {
    // OBSERVE: Collect metrics snapshot
    this.updateAction('Observing metrics');
    const snapshot = await this.observeMetrics();
    if (!snapshot) {
      return; // Failed to collect metrics
    }

    // THINK: Analyze snapshot
    this.updateAction('Analyzing snapshot');
    await this.analyzeSnapshot(snapshot);

    // DECIDE: Plan tasks if needed
    if (snapshot.events && snapshot.events.length > 0) {
      this.updateAction('Planning corrective tasks');
      await this.planTasks(snapshot);
    }

    // Save snapshot to history
    await this.persistSnapshot(snapshot);

    // Update counters
    const status = this.registry.getAgentStatus(this.agentId);
    if (status) {
      const snapshotsCollected = (status.counters.snapshotsCollected || 0) + 1;
      const eventsDetected = (status.counters.eventsDetected || 0) + (snapshot.events?.length || 0);
      this.registry.updateCounters(this.agentId, {
        snapshotsCollected,
        eventsDetected,
      });
    }
  }

  /**
   * OBSERVE: Collect metrics from Grafana
   */
  private async observeMetrics(): Promise<MetricsSnapshot | null> {
    try {
      // TODO: Call Grafana MCP service to get actual metrics
      // For now, return a mock snapshot structure
      const snapshot: MetricsSnapshot = {
        snapshotId: uuidv4(),
        collectedAt: new Date(),
        window: '5m',
        metrics: {
          // Mock metrics
          ttft: 150,
          tpot: 25,
          qps: 100,
          throughput: 4000,
          gpu_utilization: 0.85,
        },
        analyzed: false,
      };
      return snapshot;
    } catch (error) {
      this.registry.recordError(
        this.agentId,
        `Failed to collect metrics: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * THINK: Analyze snapshot for anomalies
   */
  private async analyzeSnapshot(snapshot: MetricsSnapshot): Promise<void> {
    if (snapshot.analyzed) {
      return; // Already analyzed
    }

    snapshot.events = [];

    // Compare against previous snapshot if available
    if (this.snapshotHistory.length > 0) {
      const prevSnapshot = this.snapshotHistory[this.snapshotHistory.length - 1];
      snapshot.events = this.detectAnomalies(prevSnapshot, snapshot);
    }

    snapshot.analyzed = true;
  }

  /**
   * Detect anomalies by comparing snapshots
   */
  private detectAnomalies(
    prev: MetricsSnapshot,
    curr: MetricsSnapshot
  ): DetectedEvent[] {
    const events: DetectedEvent[] = [];

    // Example: Detect TTFT spike (>200%)
    const prevTTFT = (prev.metrics.ttft as number) || 0;
    const currTTFT = (curr.metrics.ttft as number) || 0;
    if (prevTTFT > 0) {
      const percentChange = ((currTTFT - prevTTFT) / prevTTFT) * 100;
      if (percentChange > 200) {
        events.push({
          eventId: uuidv4(),
          detectedAt: new Date(),
          type: 'spike',
          metricName: 'ttft',
          currentValue: currTTFT,
          previousValue: prevTTFT,
          percentChange,
          severity: 'high',
          description: `TTFT spike: ${currTTFT}ms (was ${prevTTFT}ms)`,
        });
      }
    }

    // Example: Detect TTFT drop (<50%)
    if (prevTTFT > 0 && currTTFT < prevTTFT * 0.5) {
      const percentChange = ((currTTFT - prevTTFT) / prevTTFT) * 100;
      events.push({
        eventId: uuidv4(),
        detectedAt: new Date(),
        type: 'drop',
        metricName: 'ttft',
        currentValue: currTTFT,
        previousValue: prevTTFT,
        percentChange,
        severity: 'medium',
        description: `TTFT drop: ${currTTFT}ms (was ${prevTTFT}ms)`,
      });
    }

    return events;
  }

  /**
   * DECIDE: Plan corrective tasks
   */
  private async planTasks(snapshot: MetricsSnapshot): Promise<void> {
    if (!snapshot.events || snapshot.events.length === 0) {
      return;
    }

    // Check capacity
    const counts = this.taskRecorder.getTaskCounts();
    const totalTasks =
      counts.ready +
      counts.scheduling +
      counts.scheduled +
      counts.running;

    if (totalTasks > 50) {
      // Arbitrary capacity limit
      const status = this.registry.getAgentStatus(this.agentId);
      if (status) {
        const skipped = (status.counters.snapshotsSkipped || 0) + 1;
        this.registry.updateCounters(this.agentId, { snapshotsSkipped: skipped });
      }
      return;
    }

    // Plan tasks based on events
    snapshot.plannedTasks = [];
    for (const event of snapshot.events) {
      const task = this.createTaskFromEvent(event);
      await this.taskRecorder.createTask(task);
      snapshot.plannedTasks.push(task);
    }
  }

  /**
   * Create a task from a detected event
   */
  private createTaskFromEvent(event: DetectedEvent): Task {
    const taskType = event.type === 'spike' ? 'scale-up' : 'scale-down';
    return {
      taskId: uuidv4(),
      status: 'ready',
      createdAt: new Date(),
      statusModifiedAt: new Date(),
      priority: event.severity === 'high' ? 'high' : 'medium',
      llmDeploymentName: 'default-deployment', // TODO: Extract from event
      taskType,
      taskData: {
        eventId: event.eventId,
        metric: event.metricName,
        change: event.percentChange,
      },
      retryCount: 0,
      maxRetries: 3,
    };
  }

  /**
   * Persist snapshot to storage
   */
  private async persistSnapshot(snapshot: MetricsSnapshot): Promise<void> {
    this.snapshotHistory.push(snapshot);
    if (this.snapshotHistory.length > this.maxSnapshotCopies) {
      this.snapshotHistory.shift();
    }

    const snapshotsFile = path.join(this.storagePath, 'snapshots.json');
    await fs.writeFile(
      snapshotsFile,
      JSON.stringify(this.snapshotHistory, null, 2),
      'utf-8'
    );
  }

  /**
   * Stop the agent
   */
  async shutdown(): Promise<void> {
    this.isRunning = false;
    await super.shutdown();
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
