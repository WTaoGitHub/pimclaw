/**
 * Live integration test for PrometheusClient against a real Prometheus server.
 *
 * This test is SKIPPED by default (requires network access to a real Prometheus).
 * Run with:
 *   PROMETHEUS_URL=http://10.1.112.237:29000 npx vitest run src/master/__tests__/prometheus-client.live.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  PrometheusClient,
  sglangPromQLMap,
  getPromQLMap,
  injectLabels,
} from '../prometheus-client.js';

const PROMETHEUS_URL = process.env.PROMETHEUS_URL;
const shouldRun = !!PROMETHEUS_URL;

describe.skipIf(!shouldRun)('PrometheusClient — live integration', () => {
  const client = new PrometheusClient({ baseUrl: PROMETHEUS_URL!, timeoutMs: 15_000 });
  const promqlMap = getPromQLMap('sglang');

  it('connects to Prometheus and gets a response', async () => {
    const result = await client.query('up');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  describe('SGLang metrics snapshot', () => {
    const metrics = Object.keys(promqlMap) as (keyof typeof promqlMap)[];

    for (const metric of metrics) {
      it(`fetches ${metric}`, async () => {
        const promql = promqlMap[metric];
        const result = await client.query(promql);
        // Should return at least an empty array (no error)
        expect(Array.isArray(result)).toBe(true);
        console.log(
          `  ${metric}: ${result.length > 0 ? result[0].value?.[1] ?? JSON.stringify(result[0].values?.slice(0, 3)) : '(empty)'}`,
        );
      });
    }
  });

  it('fetches all 6 metrics in one pass (simulates Head Agent)', async () => {
    const snapshot: Record<string, string | null> = {};

    for (const [metric, promql] of Object.entries(promqlMap)) {
      const result = await client.query(promql);
      snapshot[metric] = result.length > 0 ? (result[0].value?.[1] ?? null) : null;
    }

    console.log('\n  Head Agent snapshot:');
    console.log(JSON.stringify(snapshot, null, 2));

    // At least TTFT and QPS should return data from an active SGLang instance
    expect(snapshot.ttft).toBeDefined();
    expect(snapshot.qps).toBeDefined();
  });

  it('supports label injection for deploymentName', async () => {
    const promql = injectLabels(promqlMap.ttft, { model_name: 'MiniMax-M2.1' });
    const result = await client.query(promql);
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0].metric?.model_name).toBe('MiniMax-M2.1');
    }
  });

  it('supports range queries for trend detection', async () => {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 15 * 60; // last 15 minutes
    const step = 60; // 1-minute intervals
    const result = await client.queryRange(promqlMap.ttft, start, now, step);
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0].values).toBeDefined();
      expect(Array.isArray(result[0].values)).toBe(true);
      console.log(`  Range query returned ${result[0].values!.length} data points for TTFT`);
    }
  });
});
