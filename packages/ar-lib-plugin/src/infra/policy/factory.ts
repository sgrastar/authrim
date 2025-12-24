/**
 * Policy Infrastructure Factory
 *
 * Creates policy infrastructure based on provider configuration.
 */

import type { IPolicyInfra, IStorageInfra, PolicyProvider, InfraEnv } from '../types';
import { BuiltinPolicyInfra } from './builtin';

/**
 * Options for creating policy infrastructure
 */
export interface PolicyInfraOptions {
  /** Policy provider (defaults to 'builtin') */
  provider?: PolicyProvider;
}

/**
 * Create policy infrastructure instance
 *
 * @param env - Environment bindings
 * @param storage - Storage infrastructure (required for built-in provider)
 * @param options - Policy options
 * @returns Initialized policy infrastructure
 *
 * @example
 * ```typescript
 * const storage = await createStorageInfra(env);
 * const policy = await createPolicyInfra(env, storage);
 *
 * const result = await policy.check({
 *   subject: 'user:123',
 *   relation: 'viewer',
 *   object: 'document:456',
 * });
 * ```
 */
export async function createPolicyInfra(
  env: InfraEnv,
  storage: IStorageInfra,
  options: PolicyInfraOptions = {}
): Promise<IPolicyInfra> {
  const provider = options.provider ?? (env.POLICY_PROVIDER as PolicyProvider) ?? 'builtin';

  let policy: IPolicyInfra;

  switch (provider) {
    case 'builtin':
      policy = new BuiltinPolicyInfra();
      break;

    case 'openfga':
    case 'opa':
      throw new Error(`Policy provider '${provider}' is not yet implemented`);

    case 'custom':
      throw new Error('Custom policy provider requires manual instantiation');

    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unknown policy provider: ${String(exhaustiveCheck)}`);
    }
  }

  await policy.initialize(env, storage);
  return policy;
}
