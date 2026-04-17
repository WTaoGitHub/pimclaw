import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  HeadSummaryStore,
  type HeadMonitoringSummaryRecord,
} from '../../master/head-summary-store.js';

describe('HeadSummaryStore', () => {
  let tmpDir: string;
  let store: HeadSummaryStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pimclaw-head-summary-'));
    store = new HeadSummaryStore(tmpDir, 2);
    await store.load();
  });

  function makeRecord(runId: string, currentValue: number): HeadMonitoringSummaryRecord {
    return {
      ts: Date.now(),
      runId,
      sessionId: 'session-1',
      deployments: [
        {
          deploymentName: 'minimax-m25-tp8ep',
          engine: 'vllm',
          metricTable: [
            {
              metric: 'ttft',
              currentValue,
              priorValue: null,
            },
          ],
          anomalyTable: [],
        },
      ],
    };
  }

  it('returns the latest previous metric value for the same deployment and engine', async () => {
    store.upsert(makeRecord('run-1', 0.25));
    store.upsert(makeRecord('run-2', 0.5));
    await store.flush();

    expect(
      store.findPreviousMetricValue('minimax-m25-tp8ep', 'vllm', 'ttft', 'run-2'),
    ).toBe(0.25);
  });

  it('keeps only the latest configured number of records', async () => {
    store.upsert(makeRecord('run-1', 0.1));
    store.upsert(makeRecord('run-2', 0.2));
    store.upsert(makeRecord('run-3', 0.3));
    await store.flush();

    expect(store.size).toBe(2);
    expect(store.getByRunId('run-1')).toBeNull();
    expect(store.getByRunId('run-2')).not.toBeNull();
    expect(store.getByRunId('run-3')).not.toBeNull();
  });
});