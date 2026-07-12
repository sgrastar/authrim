import { WorkerEntrypoint } from 'cloudflare:workers';
import type { JWK } from 'jose';
import type { Env } from '../types/env';
import { isValidTenantIdentifier } from '../utils/tenant-request-policy';

/**
 * Least-privilege Worker RPC facade for callers that only need tenant public signing keys.
 *
 * Binding a caller directly to KeyManager would also grant access to private-key, import,
 * and rotation RPC methods. Keep those capabilities behind the direct Durable Object binding.
 */
export class KeyManagerPublicEntrypoint extends WorkerEntrypoint<Env> {
  async getAllPublicKeys(tenantId: string): Promise<JWK[]> {
    if (!isValidTenantIdentifier(tenantId)) {
      throw new Error('invalid_tenant_id');
    }

    const keyManager = this.env.KEY_MANAGER.getByName(`${tenantId}-v3`);
    return keyManager.getAllPublicKeysRpc();
  }
}
