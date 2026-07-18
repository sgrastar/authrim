import {
  ClientRepository,
  resolveAuthCorePersistenceAdapterFromEnv,
  type Env,
} from '@authrim/ar-lib-core';
import type { JsonObject } from '../../core';
import type { AgentConfigurationStateReaderPort } from '../ports';

/** Cloudflare tenant-D1 adapter for trusted, read-only Baseline evaluation. */
export class CloudflareTenantConfigurationReader implements AgentConfigurationStateReaderPort {
  constructor(private readonly env: Env) {}

  async readCurrent(
    input: Parameters<AgentConfigurationStateReaderPort['readCurrent']>[0]
  ): Promise<JsonObject | null> {
    if (input.step.operation !== 'admin.write.clients.metadata') {
      throw new TypeError('Unsupported Baseline operation');
    }
    const clientId = input.step.input.client_id;
    if (typeof clientId !== 'string') throw new TypeError('Baseline client_id is missing');
    const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
      this.env,
      'agent-baseline-evaluation',
      { tenantId: input.tenantId }
    );
    const client = await new ClientRepository(adapter, input.tenantId).findByClientId(clientId);
    if (!client) return null;
    return Object.fromEntries(
      Object.keys(input.step.input)
        .filter((field) => field !== 'client_id' && field !== 'resource_version')
        .map((field) => [field, (client as unknown as JsonObject)[field] ?? null])
    ) as JsonObject;
  }
}
