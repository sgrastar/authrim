import {
  requireDedicatedAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  type Env,
} from '@authrim/ar-lib-core';
import {
  resolveRuntimeIdentityMappingBinding,
  loadCustomClaimSchemaCatalogEntries,
} from '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver';
import {
  evaluateInboundMapping,
  inboundProfileTargets,
  oidcInboundSources,
} from '@authrim/ar-lib-core/services/inbound-identity-mapping';
import type { UpstreamProvider, UserInfo } from '../types';

export interface OIDCInboundMappingSelector {
  fieldMappingSetId: string;
  fieldMappingVersionId: string;
}
export function oidcInboundMappingSelector(
  quirks: Record<string, unknown> = {}
): OIDCInboundMappingSelector | undefined {
  if (!Object.hasOwn(quirks, 'inboundIdentityMapping')) return undefined;
  const value = quirks.inboundIdentityMapping;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('inbound_mapping_binding_invalid');
  const fieldMappingSetId: unknown = Reflect.get(value, 'fieldMappingSetId');
  const fieldMappingVersionId: unknown = Reflect.get(value, 'fieldMappingVersionId');
  if (
    typeof fieldMappingSetId !== 'string' ||
    !fieldMappingSetId ||
    typeof fieldMappingVersionId !== 'string' ||
    !fieldMappingVersionId ||
    Object.keys(value).some((key) => !['fieldMappingSetId', 'fieldMappingVersionId'].includes(key))
  )
    throw new Error('inbound_mapping_binding_invalid');
  return { fieldMappingSetId, fieldMappingVersionId };
}

export async function mapOIDCInboundUserInfo(
  env: Env,
  tenantId: string,
  provider: UpstreamProvider,
  userInfo: UserInfo
) {
  const selector = oidcInboundMappingSelector(provider.providerQuirks);
  if (!selector) return undefined;
  if (provider.providerType !== 'oidc' || provider.tenantId !== tenantId)
    throw new Error('inbound_mapping_provider_invalid');
  const binding = await resolveRuntimeIdentityMappingBinding(
    requireDedicatedAdminDatabaseAdapter(env, 'oidc-inbound-mapping'),
    {
      tenantId,
      protocol: 'oidc',
      role: 'rp',
      providerId: provider.id,
      fieldMappingSetId: selector.fieldMappingSetId,
      fieldMappingVersionId: selector.fieldMappingVersionId,
    }
  );
  if (!binding || binding.activationScope.inboundContract !== 'connection-v1')
    throw new Error('inbound_mapping_not_active');
  const core = await resolveAuthCorePersistenceAdapterFromEnv(env, 'oidc-inbound-targets', {
    tenantId,
  });
  const result = await evaluateInboundMapping({
    env,
    tenantId,
    protocol: 'oidc',
    binding,
    sources: oidcInboundSources(userInfo, binding.catalog.entries),
    targets: inboundProfileTargets(await loadCustomClaimSchemaCatalogEntries(core, tenantId)),
  });
  // Identity and authentication evidence come only from the validated receiver, never graph output.
  const mapped: UserInfo = { ...result.profile, sub: userInfo.sub };
  for (const key of ['auth_time', 'acr', 'amr']) {
    if (Object.hasOwn(userInfo, key)) mapped[key] = userInfo[key];
  }
  if (mapped.email !== undefined)
    mapped.email_verified = mapped.email === userInfo.email && userInfo.email_verified === true;
  return { userInfo: mapped, customClaims: result.customClaims };
}
