/**
 * Ambient type declarations for openclaw/plugin-sdk.
 *
 * These mirror the subset of OpenClaw's plugin SDK that PimClaw uses.
 * When OpenClaw is available as a built package (dist/ exists), TypeScript
 * resolves types from the package exports map instead.
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  /** Minimal logger interface provided to plugins. */
  export interface PluginLogger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
  }

  /** Agent tool type — the concrete tool object shape registered via registerTool. */
  export type AnyAgentTool = {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, rawParams: Record<string, unknown>) => Promise<unknown>;
    ownerOnly?: boolean;
    displaySummary?: string;
  };

  /** Factory function that produces tools given a context. */
  export type OpenClawPluginToolFactory = (ctx: unknown) => AnyAgentTool | AnyAgentTool[] | null | undefined;

  /** Context passed to service start/stop. */
  export interface OpenClawPluginServiceContext {
    config: Record<string, unknown>;
    stateDir: string;
    workspaceDir: string;
    logger: PluginLogger;
  }

  /** Service lifecycle registered via registerService. */
  export interface OpenClawPluginService {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  }

  /** Plugin config schema shape (optional). */
  export interface OpenClawPluginConfigSchema {
    safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown };
    jsonSchema?: Record<string, unknown>;
    uiHints?: Record<string, unknown>;
  }

  /** The API object passed to register(). */
  export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    rootDir?: string;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    registerTool: (tool: AnyAgentTool | OpenClawPluginToolFactory, opts?: unknown) => void;
    registerService: (service: OpenClawPluginService) => void;
    registerHook: (events: string | string[], handler: unknown, opts?: unknown) => void;
    registerHttpRoute: (params: unknown) => void;
    registerChannel: (registration: unknown) => void;
    registerGatewayMethod: (method: string, handler: unknown, opts?: unknown) => void;
    registerCli: (registrar: unknown, opts?: unknown) => void;
    registerCliBackend: (backend: unknown) => void;
    registerProvider: (provider: unknown) => void;
    registerSpeechProvider: (provider: unknown) => void;
    registerMediaUnderstandingProvider: (provider: unknown) => void;
    registerImageGenerationProvider: (provider: unknown) => void;
    registerWebSearchProvider: (provider: unknown) => void;
    registerInteractiveHandler: (registration: unknown) => void;
    registerCommand: (command: unknown) => void;
    registerContextEngine: (id: string, factory: unknown) => void;
    registerMemoryPromptSection: (builder: unknown) => void;
    config: unknown;
    runtime: unknown;
  }

  /** Options for definePluginEntry. */
  export interface DefinePluginEntryOptions {
    id: string;
    name: string;
    description: string;
    kind?: string;
    configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
    register: (api: OpenClawPluginApi) => void | Promise<void>;
  }

  /** The normalized plugin entry object. */
  export interface DefinedPluginEntry {
    id: string;
    name: string;
    description: string;
    configSchema: OpenClawPluginConfigSchema;
    register: (api: OpenClawPluginApi) => void | Promise<void>;
    kind?: string;
  }

  /** Create a plugin entry. */
  export function definePluginEntry(opts: DefinePluginEntryOptions): DefinedPluginEntry;
}
