import type { TenantDatabaseRequestCache } from './tenant-database-resolver';
import {
  resolveAuthCorePersistenceAdapterFromEnv,
  type AuthCorePersistenceEnv,
} from './auth-core-persistence-context';
import { ConsentGateDecisionReceiptRepository } from '../repositories/identity/consent-gate-decision-receipt';
import { ConsentGatePolicyBindingRepository } from '../repositories/identity/consent-gate-policy-binding';
import { DocumentAcknowledgmentRepository } from '../repositories/identity/document-acknowledgment';
import { requireTenantId } from '../repositories/tenant';

export async function resolveConsentGatePersistenceFromEnv(
  env: AuthCorePersistenceEnv,
  tenantId: string,
  options: { requestCache?: TenantDatabaseRequestCache } = {}
) {
  const tenant = requireTenantId(tenantId, 'resolveConsentGatePersistenceFromEnv');
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'consent-gate-runtime', {
    tenantId: tenant,
    requestCache: options.requestCache,
  });
  return {
    adapter,
    policyBindings: new ConsentGatePolicyBindingRepository(adapter),
    documentAcknowledgments: new DocumentAcknowledgmentRepository(adapter),
    decisionReceipts: new ConsentGateDecisionReceiptRepository(adapter),
  };
}
