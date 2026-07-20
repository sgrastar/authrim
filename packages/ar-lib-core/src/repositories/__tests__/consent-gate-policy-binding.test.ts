import { describe, expect, it } from 'vitest';
import {
  ConsentGatePolicyBindingError,
  ConsentGatePolicyBindingRepository,
  ConsentGatePolicyConfigurationError,
  resolveConsentGatePolicyBinding,
} from '../identity';
import { MockDatabaseAdapter } from './mock-adapter';

function createRepository() {
  const adapter = new MockDatabaseAdapter();
  adapter.initTable('consent_policies', 'id');
  adapter.initTable('consent_gate_policy_bindings', 'id');
  adapter.seed('consent_policies', [
    { id: 'policy-a', tenant_id: 'tenant-a' },
    { id: 'policy-b', tenant_id: 'tenant-a' },
    { id: 'policy-other', tenant_id: 'tenant-b' },
  ]);
  return { adapter, repository: new ConsentGatePolicyBindingRepository(adapter) };
}

describe('ConsentGatePolicyBindingRepository', () => {
  it('lists only bindings in the requested tenant', async () => {
    const { adapter, repository } = createRepository();
    adapter.seed('consent_gate_policy_bindings', [
      { id: 'binding-a', tenant_id: 'tenant-a' },
      { id: 'binding-b', tenant_id: 'tenant-b' },
    ]);
    await expect(repository.list('tenant-a')).resolves.toEqual([
      expect.objectContaining({ id: 'binding-a' }),
    ]);
  });

  it('creates and reads an exact tenant-scoped binding', async () => {
    const { repository } = createRepository();
    await repository.create({
      id: 'binding-a',
      tenant_id: 'tenant-a',
      gate_kind: 'legal_document',
      target_type: 'oidc_client',
      target_id: 'client-a',
      policy_id: 'policy-a',
    });

    await expect(
      repository.findEnabledExact({
        tenant_id: 'tenant-a',
        gate_kind: 'legal_document',
        target_type: 'oidc_client',
        target_id: 'client-a',
      })
    ).resolves.toMatchObject({ id: 'binding-a', policy_id: 'policy-a' });
    await expect(
      repository.findEnabledExact({
        tenant_id: 'tenant-b',
        gate_kind: 'legal_document',
        target_type: 'oidc_client',
        target_id: 'client-a',
      })
    ).resolves.toBeNull();
  });

  it('rejects a policy owned by another tenant', async () => {
    const { repository } = createRepository();
    await expect(
      repository.create({
        tenant_id: 'tenant-a',
        gate_kind: 'legal_document',
        target_type: 'tenant',
        policy_id: 'policy-other',
      })
    ).rejects.toMatchObject<Partial<ConsentGatePolicyBindingError>>({ code: 'policy_not_found' });
  });

  it.each([
    ['tenant with target ID', 'tenant', 'client-a'],
    ['client without target ID', 'oidc_client', null],
    ['SP without target ID', 'saml_sp', ''],
  ] as const)('rejects an invalid target: %s', async (_name, target_type, target_id) => {
    const { repository } = createRepository();
    await expect(
      repository.create({
        tenant_id: 'tenant-a',
        gate_kind: 'legal_document',
        target_type,
        target_id,
        policy_id: 'policy-a',
      })
    ).rejects.toMatchObject<Partial<ConsentGatePolicyBindingError>>({ code: 'invalid_target' });
  });

  it('rejects a protocol Gate bound to the wrong exact target type', async () => {
    const { repository } = createRepository();
    await expect(
      repository.create({
        tenant_id: 'tenant-a',
        gate_kind: 'oidc_authorization',
        target_type: 'saml_sp',
        target_id: 'sp-a',
        policy_id: 'policy-a',
      })
    ).rejects.toMatchObject({ code: 'invalid_gate_target' });
  });

  it('rejects an empty exact target lookup', async () => {
    const { repository } = createRepository();
    await expect(
      repository.findEnabledExact({
        tenant_id: 'tenant-a',
        gate_kind: 'oidc_authorization',
        target_type: 'oidc_client',
        target_id: ' ',
      })
    ).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('accepts a SAML release Gate bound to a SAML SP', async () => {
    const { repository } = createRepository();
    await expect(
      repository.create({
        tenant_id: 'tenant-a',
        gate_kind: 'saml_attribute_release',
        target_type: 'saml_sp',
        target_id: 'sp-a',
        policy_id: 'policy-a',
      })
    ).resolves.toMatchObject({ gate_kind: 'saml_attribute_release', target_type: 'saml_sp' });
  });

  it('updates and deletes only within the requested tenant', async () => {
    const { repository } = createRepository();
    await repository.create({
      id: 'binding-a',
      tenant_id: 'tenant-a',
      gate_kind: 'legal_document',
      target_type: 'tenant',
      policy_id: 'policy-a',
    });
    await expect(
      repository.update('tenant-b', 'binding-a', { enabled: false })
    ).rejects.toMatchObject({ code: 'binding_not_found' });
    await expect(repository.delete('tenant-b', 'binding-a')).resolves.toBe(false);
    await expect(
      repository.update('tenant-a', 'binding-a', { policy_id: 'policy-b', enabled: false })
    ).resolves.toMatchObject({ policy_id: 'policy-b', enabled: 0 });
    await expect(repository.delete('tenant-a', 'binding-a')).resolves.toBe(true);
  });
});

describe('resolveConsentGatePolicyBinding', () => {
  it('keeps legacy consent_policy_ref as a fixed Policy', async () => {
    const { repository } = createRepository();
    await expect(
      resolveConsentGatePolicyBinding({
        repository,
        tenantId: 'tenant-a',
        nodeConfig: { consent_policy_ref: 'policy-a' },
        gateKind: 'legal_document',
        targetType: 'oidc_client',
        targetId: 'client-a',
      })
    ).resolves.toMatchObject({ policyId: 'policy-a', source: 'fixed', binding: null });
  });

  it('uses exact, tenant default, fallback, and optional skip in order', async () => {
    const { repository } = createRepository();
    await repository.create({
      id: 'default-binding',
      tenant_id: 'tenant-a',
      gate_kind: 'legal_document',
      target_type: 'tenant',
      policy_id: 'policy-a',
    });
    await repository.create({
      id: 'exact-binding',
      tenant_id: 'tenant-a',
      gate_kind: 'legal_document',
      target_type: 'oidc_client',
      target_id: 'client-a',
      policy_id: 'policy-b',
    });
    const base = {
      repository,
      tenantId: 'tenant-a',
      nodeConfig: { policy_resolution: 'target_binding' as const },
      gateKind: 'legal_document' as const,
      targetType: 'oidc_client' as const,
    };
    await expect(
      resolveConsentGatePolicyBinding({ ...base, targetId: 'client-a' })
    ).resolves.toMatchObject({ policyId: 'policy-b', source: 'exact_binding' });
    await expect(
      resolveConsentGatePolicyBinding({ ...base, targetId: 'client-b' })
    ).resolves.toMatchObject({ policyId: 'policy-a', source: 'tenant_default' });

    await repository.delete('tenant-a', 'exact-binding');
    await repository.delete('tenant-a', 'default-binding');
    await expect(
      resolveConsentGatePolicyBinding({
        ...base,
        targetId: 'client-b',
        nodeConfig: { policy_resolution: 'target_binding', fallback_policy_ref: 'policy-b' },
      })
    ).resolves.toMatchObject({ policyId: 'policy-b', source: 'fallback' });
    await expect(
      resolveConsentGatePolicyBinding({ ...base, targetId: 'client-b' })
    ).resolves.toMatchObject({ policyId: null, source: 'skip' });
  });

  it('fails closed when a required Policy cannot be resolved', async () => {
    const { repository } = createRepository();
    await expect(
      resolveConsentGatePolicyBinding({
        repository,
        tenantId: 'tenant-a',
        nodeConfig: { policy_resolution: 'target_binding', policy_required: true },
        gateKind: 'saml_attribute_release',
        targetType: 'saml_sp',
        targetId: 'sp-a',
      })
    ).rejects.toBeInstanceOf(ConsentGatePolicyConfigurationError);
  });

  it('skips an unavailable optional fixed Policy and denies an unavailable required one', async () => {
    const { repository } = createRepository();
    const input = {
      repository,
      tenantId: 'tenant-a',
      gateKind: 'legal_document' as const,
      targetType: 'tenant' as const,
      targetId: null,
    };
    await expect(
      resolveConsentGatePolicyBinding({
        ...input,
        nodeConfig: { policy_resolution: 'fixed', consent_policy_ref: 'missing' },
      })
    ).resolves.toMatchObject({ policyId: null, source: 'skip' });
    await expect(
      resolveConsentGatePolicyBinding({
        ...input,
        nodeConfig: {
          policy_resolution: 'fixed',
          consent_policy_ref: 'missing',
          policy_required: true,
        },
      })
    ).rejects.toBeInstanceOf(ConsentGatePolicyConfigurationError);
  });
});
