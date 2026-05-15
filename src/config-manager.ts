/**
 * PimClaw Configuration System
 * Handles YAML parsing, environment variables, and validation
 */

import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import { MCPServiceConfig, AgentConfig } from './types/index.js';

/**
 * Configuration interface
 */
export interface PimClawConfig {
  version: string;
  agents: {
    head?: AgentConfig & { snapshotInterval?: number; snapshotStalenessMs?: number };
    scheduler?: AgentConfig & { maxConcurrentWorkers?: number; pollingIntervalMs?: number };
    recorder?: AgentConfig;
    worker?: AgentConfig & { executionTimeout?: number };
  };
  mcp: {
    services: Record<string, MCPServiceConfig>;
  };
  prometheus?: {
    baseUrl: string;
    engine?: 'vllm' | 'sglang' | Array<'vllm' | 'sglang'>;
    queryOverrides?: Record<string, string>;
    defaultLabels?: Record<string, string>;
    timeoutMs?: number;
    username?: string;
    password?: string;
    bearerToken?: string;
  };
  fakePrometheusRemediation?: {
    baseUrl: string;
    timeoutMs?: number;
  };
  storage?: {
    path?: string;
    type?: 'file' | 'database';
  };
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    format?: 'json' | 'text';
  };
}

/**
 * Configuration Manager
 */
export class ConfigurationManager {
  private config: PimClawConfig | null = null;
  private configPath: string;

  constructor(configPath: string = './pimclaw.config.yaml') {
    this.configPath = configPath;
  }

  /**
   * Load configuration from YAML file
   */
  async loadConfig(): Promise<PimClawConfig> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const rawConfig = YAML.parse(content);
      this.config = await this.processConfig(rawConfig);
      return this.config;
    } catch (error) {
      throw new Error(
        `Failed to load config from ${this.configPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Process and validate configuration
   * Replaces environment variable references
   */
  private async processConfig(rawConfig: any): Promise<PimClawConfig> {
    // Substitute environment variables
    const processed = this.substituteEnvVars(JSON.stringify(rawConfig));
    const config = JSON.parse(processed) as PimClawConfig;

    // Validate required fields
    if (!config.version) {
      throw new Error('Configuration must have a version field');
    }

    if (!config.mcp || !config.mcp.services) {
      throw new Error('Configuration must define MCP services');
    }

    // Set defaults
    config.storage = config.storage || { path: './pimclaw-data', type: 'file' };
    config.logging = config.logging || { level: 'info', format: 'text' };

    // Validate MCP services
    for (const [serviceName, serviceConfig] of Object.entries(
      config.mcp.services
    )) {
      if (!serviceConfig.command) {
        throw new Error(`MCP service '${serviceName}' must have a command`);
      }
    }

    return config;
  }

  /**
   * Substitute environment variable references
   * Supports ${ENV_VAR} syntax
   */
  private substituteEnvVars(content: string): string {
    return content.replace(/\$\{([A-Z_]+)\}/g, (match, envVar) => {
      const value = process.env[envVar];
      if (!value) {
        throw new Error(
          `Required environment variable not set: ${envVar}`
        );
      }
      return value;
    });
  }

  /**
   * Get loaded configuration
   */
  getConfig(): PimClawConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call loadConfig() first.');
    }
    return this.config;
  }

  /**
   * Get agent-specific configuration
   */
  getAgentConfig(agentType: string): AgentConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call loadConfig() first.');
    }

    const agentConfig = (this.config.agents as any)[agentType];
    if (!agentConfig) {
      throw new Error(`No configuration found for agent type: ${agentType}`);
    }

    return agentConfig;
  }

  /**
   * Get MCP service configuration
   */
  getMCPServiceConfig(serviceName: string): MCPServiceConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call loadConfig() first.');
    }

    const serviceConfig = this.config.mcp.services[serviceName];
    if (!serviceConfig) {
      throw new Error(`No MCP service configured: ${serviceName}`);
    }

    return serviceConfig;
  }

  /**
   * Create default configuration file
   */
  static async createDefaultConfig(outputPath: string): Promise<void> {
    const defaultConfig: PimClawConfig = {
      version: '1.0.0',
      agents: {
        head: {
          agentId: 'head-1',
          agentType: 'head',
          snapshotInterval: 5 * 60 * 1000, // 5 minutes
          snapshotStalenessMs: 60 * 1000, // 1 minute
        },
        scheduler: {
          agentId: 'scheduler-1',
          agentType: 'scheduler',
          maxConcurrentWorkers: 10,
          pollingIntervalMs: 5 * 1000, // 5 seconds
        },
        recorder: {
          agentId: 'recorder-1',
          agentType: 'recorder',
        },
        worker: {
          agentId: 'worker-template',
          agentType: 'worker',
          executionTimeout: 30 * 60 * 1000, // 30 minutes
        },
      },
      mcp: {
        services: {
          grafana: {
            command: 'node',
            args: ['./mcp-servers/grafana-server.js'],
            env: {
              GRAFANA_URL: '${GRAFANA_URL}',
              GRAFANA_API_KEY: '${GRAFANA_API_KEY}',
            },
          },
          perf: {
            command: 'node',
            args: ['./mcp-servers/perf-server.js'],
            env: {
              PERF_API_URL: '${PERF_API_URL}',
            },
          },
          engine: {
            command: 'node',
            args: ['./mcp-servers/engine-server.js'],
            env: {
              ENGINE_API_URL: '${ENGINE_API_URL}',
              ENGINE_API_KEY: '${ENGINE_API_KEY}',
            },
          },
        },
      },
      storage: {
        path: './pimclaw-data',
        type: 'file',
      },
      logging: {
        level: 'info',
        format: 'text',
      },
    };

    const yaml = YAML.stringify(defaultConfig);
    await fs.writeFile(outputPath, yaml, 'utf-8');
    console.log(`Default configuration written to ${outputPath}`);
  }
}
