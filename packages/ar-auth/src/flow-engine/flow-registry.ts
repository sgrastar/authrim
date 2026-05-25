/**
 * FlowRegistry - retrieve and manage flow definitions
 *
 * Responsibilities:
 * - get custom flow from relational store (via Admin UI)
 * - get built-in flow
 * - from KVcustom flowget (legacy)
 *
 * Priority order:
 * 1. relational store: client-specific flow (tenant_id + client_id + profile_id)
 * 2. relational store: tenant default flow (tenant_id + profile_id, client_id = NULL)
 * 3. built-in flow
 * 4. KV: custom flow (legacy)
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import { ensureDatabaseAdapter, type DatabaseSource } from '@authrim/ar-lib-core';
import type { GraphDefinition } from './types';
import { BUILTIN_FLOWS, getBuiltinFlow } from './flows/login-flow';

// =============================================================================
// Types
// =============================================================================

/**
 * FlowType - supported flow type
 */
export type FlowType = 'login' | 'authorization' | 'consent' | 'logout';

/**
 * FlowRegistryOptions
 */
export interface FlowRegistryOptions {
  /** KVNamespace (custom flowfor, legacy) */
  kv?: KVNamespace;
  /** DatabaseSource (recommended: custom flow from Admin UI) */
  db?: DatabaseSource;
}

// =============================================================================
// FlowRegistry
// =============================================================================

/**
 * FlowRegistry - retrieve and manage flow definitions
 *
 * Supports headless operation:
 * - Works with built-in flows only
 * - get custom flows from Admin UI when relational store is configured
 * - can also get legacy custom flows when KV is configured
 */
export class FlowRegistry {
  private kv?: KVNamespace;
  private db?: DatabaseSource;

  constructor(options: FlowRegistryOptions = {}) {
    this.kv = options.kv;
    this.db = options.db;
  }

  /**
   * Get a GraphDefinition from FlowType
   *
   * Priority order:
   * 1. Database: client-specific flow (tenant_id + client_id + profile_id)
   * 2. Database: tenant default flow (tenant_id + profile_id, client_id = NULL)
   * 3. built-in flow
   * 4. KV: custom flow (legacy)
   *
   * @param flowType - Flow type
   * @param tenantId - Tenant ID
   * @param clientId - Client ID (options, client-specific flowfor)
   * @returns GraphDefinition or null
   */
  async getFlow(
    flowType: FlowType,
    tenantId?: string,
    clientId?: string
  ): Promise<GraphDefinition | null> {
    // Resolve profileId (flowType -> profileId)
    const profileId = this.flowTypeToProfileId(flowType);

    // 1. Database: client-specific flow
    if (this.db && tenantId && clientId) {
      const clientFlow = await this.getFlowFromDatabase(tenantId, profileId, clientId);
      if (clientFlow) {
        return clientFlow;
      }
    }

    // 2. Database: tenant default flow
    if (this.db && tenantId) {
      const tenantFlow = await this.getFlowFromDatabase(tenantId, profileId, null);
      if (tenantFlow) {
        return tenantFlow;
      }
    }

    // 3. Find built-in flow
    const builtinFlowId = this.getBuiltinFlowId(flowType);
    const builtinFlow = getBuiltinFlow(builtinFlowId);

    if (builtinFlow) {
      return builtinFlow;
    }

    // 4. Find custom flow in KV (legacy)
    if (this.kv && tenantId) {
      const customFlow = await this.getCustomFlowFromKV(tenantId, flowType);
      if (customFlow) {
        return customFlow;
      }
    }

    // 5. Return null when not found
    return null;
  }

  /**
   * Get all built-in flow IDs
   */
  getBuiltinFlowIds(): string[] {
    return Object.keys(BUILTIN_FLOWS);
  }

  /**
   * Resolve a built-in flow ID from FlowType
   */
  private getBuiltinFlowId(flowType: FlowType): string {
    // FlowType -> built-in flow ID mapping
    const flowTypeToId: Record<FlowType, string> = {
      login: 'human-basic-login',
      authorization: 'human-basic-authorization', // Add in the future
      consent: 'human-basic-consent', // Add in the future
      logout: 'human-basic-logout', // Add in the future
    };

    return flowTypeToId[flowType];
  }

  /**
   * Resolve ProfileId from FlowType
   */
  private flowTypeToProfileId(flowType: FlowType): string {
    // FlowType -> ProfileID mapping
    // Currently all use 'human-basic'
    const flowTypeToProfile: Record<FlowType, string> = {
      login: 'human-basic',
      authorization: 'human-basic',
      consent: 'human-basic',
      logout: 'human-basic',
    };

    return flowTypeToProfile[flowType];
  }

  /**
   * Get the flow definition from Database
   *
   * @param tenantId - Tenant ID
   * @param profileId - profile ID
   * @param clientId - Client ID (tenant default when NULL)
   */
  private async getFlowFromDatabase(
    tenantId: string,
    profileId: string,
    clientId: string | null
  ): Promise<GraphDefinition | null> {
    if (!this.db) {
      return null;
    }

    try {
      const adapter = ensureDatabaseAdapter(this.db, 'flow-registry');
      let rows: Array<{ graph_definition: string }>;

      if (clientId) {
        rows = await adapter.query<{ graph_definition: string }>(
          `SELECT graph_definition FROM flows
             WHERE tenant_id = ? AND profile_id = ? AND client_id = ?
             AND is_active = 1`,
          [tenantId, profileId, clientId]
        );
      } else {
        rows = await adapter.query<{ graph_definition: string }>(
          `SELECT graph_definition FROM flows
             WHERE tenant_id = ? AND profile_id = ? AND client_id IS NULL
             AND is_active = 1`,
          [tenantId, profileId]
        );
      }

      if (rows.length > 0) {
        const row = rows[0];
        const graphDef = JSON.parse(row.graph_definition);

        if (this.isValidGraphDefinition(graphDef)) {
          return graphDef;
        }
      }

      return null;
    } catch (error) {
      // Security mitigation (High 9): Log only the message instead of the raw error object
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to get flow from database: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get custom flow definition from KV (legacy)
   *
   * Key format: flow:{tenantId}:{flowType}
   */
  private async getCustomFlowFromKV(
    tenantId: string,
    flowType: string
  ): Promise<GraphDefinition | null> {
    if (!this.kv) {
      return null;
    }

    const key = `flow:${tenantId}:${flowType}`;
    const stored = await this.kv.get(key, 'json');

    if (stored && this.isValidGraphDefinition(stored)) {
      return stored as GraphDefinition;
    }

    return null;
  }

  /**
   * Basic GraphDefinition validation
   */
  private isValidGraphDefinition(obj: unknown): obj is GraphDefinition {
    if (!obj || typeof obj !== 'object') {
      return false;
    }

    const graph = obj as Partial<GraphDefinition>;

    return (
      typeof graph.id === 'string' &&
      typeof graph.flowVersion === 'string' &&
      typeof graph.name === 'string' &&
      Array.isArray(graph.nodes) &&
      Array.isArray(graph.edges)
    );
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a FlowRegistry
 *
 * @param options - options
 * @returns FlowRegistry instance
 *
 * @example
 * // built-in flows only
 * const registry = createFlowRegistry();
 *
 * // DatabaseSource support (recommended: custom flow from Admin UI)
 * const registry = createFlowRegistry({ db: env.DB });
 *
 * // DatabaseSource + KVsupport (full options)
 * const registry = createFlowRegistry({ db: env.DB, kv: env.AUTHRIM_CONFIG });
 */
export function createFlowRegistry(options: FlowRegistryOptions = {}): FlowRegistry {
  return new FlowRegistry(options);
}

// =============================================================================
// Export
// =============================================================================

export default FlowRegistry;
