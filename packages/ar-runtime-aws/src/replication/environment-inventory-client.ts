import {
  assertEnvironmentSourceInventory,
  type EnvironmentReplicationInventory,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-inventory';
import type { EnvironmentReplicationConfiguration } from './environment-plan';

/** A dedicated metadata grant cannot export data or invoke general Management APIs. */
export async function readEnvironmentReplicationInventory(input: {
  configuration: EnvironmentReplicationConfiguration;
  credential: string;
  minimumObservedAtMs?: number;
  fetch?: typeof fetch;
  nowMs?: number;
}): Promise<EnvironmentReplicationInventory> {
  try {
    if (!/^[a-f0-9]{64}$/u.test(input.credential)) throw new Error();
    const { inventory, pair } = input.configuration;
    const response = await (input.fetch ?? fetch)(
      `${inventory.managementOrigin}/api/replication-environments/${encodeURIComponent(inventory.grantId)}/inventory`,
      {
        headers: {
          Authorization: `Bearer ${input.credential}`,
          'X-Tenant-Id': inventory.ownerTenantId,
        },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw new Error();
        size += part.value.byteLength;
        if (size > 64 * 1024) throw new Error();
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = await assertEnvironmentSourceInventory(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    );
    const now = input.nowMs ?? Date.now();
    if (
      value.environmentId !== pair.environmentId ||
      value.pairId !== pair.pairId ||
      value.sourceDeploymentId !== input.configuration.sourceDeploymentId ||
      value.observedAtMs > now + 30_000 ||
      now - value.observedAtMs > 60_000 ||
      value.observedAtMs < (input.minimumObservedAtMs ?? 0) ||
      value.tenants.length !== input.configuration.tenants.length ||
      value.tenants.some((tenant, index) => {
        const selected = input.configuration.tenants[index];
        return (
          tenant.tenantId !== selected.pair.tenantId ||
          tenant.issuer !== selected.source.identity.issuer ||
          tenant.productVersion !== selected.source.identity.productVersion
        );
      })
    )
      throw new Error();
    return value;
  } catch {
    throw new Error('environment_replication_inventory_unavailable');
  }
}
