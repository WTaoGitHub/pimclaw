import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PrometheusClient,
  vllmPromQLMap,
  injectLabels,
} from '../prometheus-client.js';
import type { PrometheusResponse } from '../prometheus-client.js';

// ─── injectLabels ──────────────────────────────────────────────────────────

describe('injectLabels', () => {
  it('returns promql unchanged when labels are empty', () => {
    const q = 'sum(rate(vllm:request_success_total[5m]))';
    expect(injectLabels(q, {})).toBe(q);
  });

  it('injects labels into a metric without existing selectors', () => {
    const q = 'vllm:kv_cache_usage_perc';
    const result = injectLabels(q, { model_name: 'llama' });
    expect(result).toContain('{model_name="llama"}');
    expect(result).toBe('vllm:kv_cache_usage_perc{model_name="llama"}');
  });

  it('injects labels into a metric with a range vector', () => {
    const q = 'rate(vllm:request_success_total[5m])';
    const result = injectLabels(q, { model_name: 'llama' });
    expect(result).toContain('{model_name="llama"}');
    expect(result).toContain('[5m]');
  });

  it('appends labels inside existing selectors', () => {
    const q = 'sum(rate(vllm:request_success_total{finished_reason="error"}[5m]))';
    const result = injectLabels(q, { model_name: 'llama' });
    expect(result).toContain('model_name="llama"');
    expect(result).toContain('finished_reason="error"');
  });

  it('handles multiple labels', () => {
    const q = 'vllm:kv_cache_usage_perc';
    const result = injectLabels(q, { model_name: 'llama', engine: 'vllm' });
    expect(result).toContain('model_name="llama"');
    expect(result).toContain('engine="vllm"');
  });
});

// ─── vllmPromQLMap ────────────────────────────────────────────────────────

describe('vllmPromQLMap', () => {
  it('contains all 6 PimClaw metrics', () => {
    const expected = ['ttft', 'tpot', 'qps', 'throughput', 'gpu_utilization', 'error_rate'];
    for (const metric of expected) {
      expect(vllmPromQLMap).toHaveProperty(metric);
      expect(typeof vllmPromQLMap[metric]).toBe('string');
      expect(vllmPromQLMap[metric].length).toBeGreaterThan(0);
    }
  });

  it('uses P95 quantile for latency metrics', () => {
    expect(vllmPromQLMap.ttft).toContain('histogram_quantile(0.95');
    expect(vllmPromQLMap.tpot).toContain('histogram_quantile(0.95');
  });

  it('uses 5m rate windows', () => {
    expect(vllmPromQLMap.ttft).toContain('[5m]');
    expect(vllmPromQLMap.qps).toContain('[5m]');
    expect(vllmPromQLMap.throughput).toContain('[5m]');
  });
});

// ─── PrometheusClient ─────────────────────────────────────────────────────

describe('PrometheusClient', () => {
  let client: PrometheusClient;
  const mockFetch = vi.fn();

  beforeEach(() => {
    // Replace global fetch
    vi.stubGlobal('fetch', mockFetch);
    client = new PrometheusClient({ baseUrl: 'http://prometheus:9090' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSuccessResponse(result: unknown[]): void {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        status: 'success',
        data: { resultType: 'vector', result },
      }),
    });
  }

  function mockErrorResponse(errorMsg: string): void {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        status: 'error',
        errorType: 'bad_data',
        error: errorMsg,
      }),
    });
  }

  describe('query', () => {
    it('sends PromQL to /api/v1/query and returns results', async () => {
      const fakeResult = [
        { metric: { model_name: 'llama' }, value: [1712000000, '0.42'] },
      ];
      mockSuccessResponse(fakeResult);

      const result = await client.query('vllm:kv_cache_usage_perc');

      expect(mockFetch).toHaveBeenCalledOnce();
      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl.toString()).toContain('/api/v1/query');
      expect(calledUrl.toString()).toContain('query=vllm');
      expect(result).toEqual(fakeResult);
    });

    it('throws on Prometheus error response', async () => {
      mockErrorResponse('invalid expression');

      await expect(client.query('bad{{')).rejects.toThrow('invalid expression');
    });

    it('URL-encodes the PromQL query', async () => {
      mockSuccessResponse([]);

      await client.query('sum(rate(vllm:x{a="b"}[5m]))');

      const calledUrl = new URL(mockFetch.mock.calls[0][0].toString());
      const query = calledUrl.searchParams.get('query');
      expect(query).toBe('sum(rate(vllm:x{a="b"}[5m]))');
    });
  });

  describe('queryRange', () => {
    it('sends PromQL to /api/v1/query_range with start/end/step', async () => {
      const fakeResult = [
        {
          metric: { model_name: 'llama' },
          values: [
            [1712000000, '0.1'],
            [1712000015, '0.2'],
          ],
        },
      ];
      mockSuccessResponse(fakeResult);

      const result = await client.queryRange('vllm:kv_cache_usage_perc', 1000, 2000, 15);

      expect(mockFetch).toHaveBeenCalledOnce();
      const calledUrl = new URL(mockFetch.mock.calls[0][0].toString());
      expect(calledUrl.pathname).toBe('/api/v1/query_range');
      expect(calledUrl.searchParams.get('start')).toBe('1000');
      expect(calledUrl.searchParams.get('end')).toBe('2000');
      expect(calledUrl.searchParams.get('step')).toBe('15');
      expect(result).toEqual(fakeResult);
    });

    it('throws on Prometheus error response', async () => {
      mockErrorResponse('execution error');

      await expect(
        client.queryRange('bad', 1000, 2000, 15),
      ).rejects.toThrow('execution error');
    });
  });

  describe('authentication', () => {
    it('sends Bearer token header when configured', async () => {
      const authedClient = new PrometheusClient({
        baseUrl: 'http://prometheus:9090',
        bearerToken: 'my-secret-token',
      });
      mockSuccessResponse([]);

      await authedClient.query('up');

      const fetchOpts = mockFetch.mock.calls[0][1];
      expect(fetchOpts.headers).toHaveProperty('Authorization', 'Bearer my-secret-token');
    });

    it('sends Basic auth header when username/password configured', async () => {
      const authedClient = new PrometheusClient({
        baseUrl: 'http://prometheus:9090',
        username: 'admin',
        password: 'secret',
      });
      mockSuccessResponse([]);

      await authedClient.query('up');

      const fetchOpts = mockFetch.mock.calls[0][1];
      const expected = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
      expect(fetchOpts.headers).toHaveProperty('Authorization', expected);
    });

    it('prefers Bearer token over basic auth', async () => {
      const authedClient = new PrometheusClient({
        baseUrl: 'http://prometheus:9090',
        bearerToken: 'token',
        username: 'admin',
        password: 'secret',
      });
      mockSuccessResponse([]);

      await authedClient.query('up');

      const fetchOpts = mockFetch.mock.calls[0][1];
      expect(fetchOpts.headers['Authorization']).toContain('Bearer');
    });
  });

  describe('timeout', () => {
    it('uses AbortSignal.timeout with configured ms', async () => {
      const shortClient = new PrometheusClient({
        baseUrl: 'http://prometheus:9090',
        timeoutMs: 500,
      });
      mockSuccessResponse([]);

      await shortClient.query('up');

      const fetchOpts = mockFetch.mock.calls[0][1];
      expect(fetchOpts.signal).toBeDefined();
    });
  });

  describe('trailing slash handling', () => {
    it('strips trailing slash from baseUrl', async () => {
      const slashClient = new PrometheusClient({
        baseUrl: 'http://prometheus:9090/',
      });
      mockSuccessResponse([]);

      await slashClient.query('up');

      const calledUrl = mockFetch.mock.calls[0][0].toString();
      expect(calledUrl).not.toContain('//api');
    });
  });
});
