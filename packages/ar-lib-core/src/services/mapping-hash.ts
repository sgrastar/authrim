import {
  executeRuntimeMapping,
  executePreparedRuntimeMapping,
} from '@authrim/ar-lib-field-mapping/runtime';
import type { MappingStepPreparer } from '@authrim/ar-lib-field-mapping/runtime';
import type {
  MappingEvaluationValue,
  MappingInput,
  MappingRuleGraph,
} from '@authrim/ar-lib-field-mapping/contract';

/** Minimum existing KeyManager RPC surface; callers cannot supply a secret in step settings. */
export interface MappingHashEnvironment {
  KEY_MANAGER?: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): object;
  };
}

function isKeyReader(stub: object): stub is { getExistingSecretRpc(ref: string): unknown } {
  return typeof Reflect.get(stub, 'getExistingSecretRpc') === 'function';
}
function isKeyProvisioner(stub: object): stub is { provisionMappingHashKeyRpc(): unknown } {
  return typeof Reflect.get(stub, 'provisionMappingHashKeyRpc') === 'function';
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Dedicated tenant secret; generic create/rotate endpoints cannot modify it. */
export { MAPPING_HASH_SECRET_REF } from './mapping-hash-ref';
import { MAPPING_HASH_SECRET_REF } from './mapping-hash-ref';

/** Only call from an authorized authoring mutation, after graph validation. */
export async function provisionMappingHashKey(
  env: MappingHashEnvironment,
  tenantId: string,
  rules: readonly { transforms?: readonly { operation: string }[] }[]
): Promise<void> {
  if (!rules.some((rule) => rule.transforms?.some((step) => step.operation === 'hash'))) return;
  if (!env.KEY_MANAGER || !tenantId) throw new Error('mapping_hash_key_unavailable');
  const stub = env.KEY_MANAGER.get(env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
  if (!isKeyProvisioner(stub)) throw new Error('mapping_hash_key_unavailable');
  try {
    await stub.provisionMappingHashKeyRpc();
  } catch {
    throw new Error('mapping_hash_key_unavailable');
  }
}

/** The tenant comes from the authenticated runtime, never from a source envelope or step params. */
export function tenantMappingHashPreparer(
  env: MappingHashEnvironment,
  tenantId: string
): MappingStepPreparer {
  let key: Promise<CryptoKey | null> | undefined;
  const loadKey = async (): Promise<CryptoKey | null> => {
    if (!env.KEY_MANAGER || !tenantId) return null;
    const stub = env.KEY_MANAGER.get(env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
    if (!isKeyReader(stub)) return null;
    const stored = await stub.getExistingSecretRpc(MAPPING_HASH_SECRET_REF);
    if (!record(stored) || stored.secretRef !== MAPPING_HASH_SECRET_REF || !record(stored.active))
      return null;
    const value = stored.active.value;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
    const bytes = Uint8Array.from(
      atob(value.replace(/-/gu, '+').replace(/_/gu, '/') + '='),
      (char) => char.charCodeAt(0)
    );
    return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
  };
  return async ({ step, inputs }): Promise<MappingEvaluationValue> => {
    if (step.operation !== 'hash') return { kind: 'failed' };
    const input = inputs[0];
    if (!input || input.kind !== 'value') return input ?? { kind: 'failed' };
    // Hash strings as UTF-8; null passes through. Structured and numeric input requires an explicit text conversion.
    if (input.envelope.value === null) return input;
    if (typeof input.envelope.value !== 'string') return { kind: 'failed' };
    key ??= loadKey();
    const active = await key;
    if (!active) return { kind: 'failed' };
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', active, new TextEncoder().encode(input.envelope.value))
    );
    const value =
      step.parameters?.encoding === 'hex'
        ? [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('')
        : btoa(String.fromCharCode(...signature))
            .replace(/\+/gu, '-')
            .replace(/\//gu, '_')
            .replace(/=+$/u, '');
    return { kind: 'value', envelope: { ...input.envelope, value } };
  };
}

export async function executeTenantMapping(
  env: MappingHashEnvironment,
  tenantId: string,
  input: MappingInput
) {
  if (!input.graphRules?.some((rule) => rule.transforms.some((step) => step.operation === 'hash')))
    return executeRuntimeMapping(input);
  return executePreparedRuntimeMapping(input, tenantMappingHashPreparer(env, tenantId));
}

/** Synchronous receivers consume W1a preparedSteps; consent deferral is a state, never text. */
export async function prepareTenantMappingHashes(
  env: MappingHashEnvironment,
  tenantId: string,
  rules: MappingRuleGraph[],
  input: Omit<MappingInput, 'graphRules'>,
  defer = false
): Promise<ReadonlyMap<string, MappingEvaluationValue>> {
  const results = new Map<string, MappingEvaluationValue>();
  if (!rules.some((rule) => rule.transforms.some((step) => step.operation === 'hash')))
    return results;
  const prepare = tenantMappingHashPreparer(env, tenantId);
  await executePreparedRuntimeMapping(
    { ...input, graphRules: rules, allowDeferredOutputs: defer },
    async (request) => {
      const first = request.inputs[0];
      const result: MappingEvaluationValue = defer
        ? first?.kind === 'value' &&
          (first.envelope.value === null || typeof first.envelope.value === 'string')
          ? first.envelope.value === null
            ? first
            : { kind: 'deferred' }
          : { kind: 'failed' }
        : await prepare(request);
      results.set(request.step.id, result);
      return result;
    }
  );
  return results;
}
