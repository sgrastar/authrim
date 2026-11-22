/**
 * Test-only scaffolding: the step-by-step Mapping Set handlers that used to be routed under
 * /api/admin/identity-mapping/field-mapping-sets. They are no longer routed in production (the
 * live surface is /api/admin/identity-mapping/sets), but several suites still drive the
 * repository and the reference guards through these steps, so they are kept here, out of the
 * shipped bundle.
 */
import { PLATFORM_MAPPING_TENANT_ID } from '@authrim/ar-lib-core';
import {
  assertPlatformOwnerScopeAllowed,
  handleControlPlane,
  handleMutation,
  isRecord,
  refuseIfInUse,
  requiredParam,
  resolveFieldMappingSetOwner,
  type AdminContext,
} from '../../identity-mapping-control-plane';
import {
  checkMappingSetUnreferenced,
  checkMappingVersionDeactivation,
  checkMappingVersionSwap,
} from '../../identity-mapping-set-reference-guard';

export async function adminIdentityFieldMappingSetsListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    fieldMappingSets: await repository.listFieldMappingSets(tenantId),
  }));
}

export async function adminIdentityFieldMappingVersionsListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => {
    const fieldMappingSetId = requiredParam(c, 'fieldMappingSetId');
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      tenantId,
      fieldMappingSetId,
      'read'
    );
    return {
      fieldMappingVersions: await repository.listFieldMappingVersions(
        ownerTenantId,
        fieldMappingSetId
      ),
    };
  });
}

export async function adminIdentityFieldMappingSetCreateHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.create', async (repository, tenantId, body) => {
    // The set is created in the platform's namespace, or in the caller's. The owner scope in the
    // body only picks between the two, and the platform's needs platform authority.
    assertPlatformOwnerScopeAllowed(c, body);
    const ownerTenantId =
      isRecord(body) && body.ownerScopeType === 'platform' ? PLATFORM_MAPPING_TENANT_ID : tenantId;
    return repository.createFieldMappingSet(ownerTenantId, body as never);
  });
}

export async function adminIdentityFieldMappingSetDeleteHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.delete', async (repository, tenantId) => {
    const fieldMappingSetId = requiredParam(c, 'fieldMappingSetId');
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      tenantId,
      fieldMappingSetId,
      'write'
    );
    // A set that is still named (a default, an app, a credential profile) cannot be deleted.
    refuseIfInUse(
      await checkMappingSetUnreferenced(c, {
        setId: fieldMappingSetId,
        ownerTenantId,
        action: 'deleted',
      })
    );
    return repository.deleteFieldMappingSet(ownerTenantId, fieldMappingSetId);
  });
}

export async function adminIdentityFieldMappingVersionCreateHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.create', async (repository, tenantId, body) => {
    const request = body as { authorId?: string };
    // The shape is checked by the repository, as it was when this was the routed handler.
    const adminAuth = (
      c as unknown as { get: (key: string) => { userId?: string } | undefined }
    ).get('adminAuth');
    const fieldMappingSetId = requiredParam(c, 'fieldMappingSetId');
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      tenantId,
      fieldMappingSetId,
      'write'
    );
    return repository.createFieldMappingVersion(ownerTenantId, fieldMappingSetId, {
      ...request,
      authorId: request.authorId ?? adminAuth?.userId,
    } as never);
  });
}

export async function adminIdentityFieldMappingVersionPublishHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.publish', async (repository, tenantId) => {
    const fieldMappingSetId = requiredParam(c, 'fieldMappingSetId');
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      tenantId,
      fieldMappingSetId,
      'write'
    );
    return repository.publishFieldMappingVersion(
      ownerTenantId,
      fieldMappingSetId,
      requiredParam(c, 'fieldMappingVersionId')
    );
  });
}

export async function adminIdentityFieldMappingVersionCompileHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.compile', async (repository, tenantId, body) => {
    const fieldMappingSetId = requiredParam(c, 'fieldMappingSetId');
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      tenantId,
      fieldMappingSetId,
      'write'
    );
    return repository.compileFieldMappingVersion(
      ownerTenantId,
      fieldMappingSetId,
      requiredParam(c, 'fieldMappingVersionId'),
      body as never
    );
  });
}

export async function adminIdentityFieldMappingVersionActivateHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.activate', async (repository, tenantId, body) => {
    const fieldMappingSetId = requiredParam(c, 'fieldMappingSetId');
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      tenantId,
      fieldMappingSetId,
      'write'
    );
    const fieldMappingVersionId = requiredParam(c, 'fieldMappingVersionId');
    // Replacing the version in use must not break what names the set.
    const snapshotId = isRecord(body) ? body.snapshotId : undefined;
    if (typeof snapshotId === 'string' && snapshotId) {
      refuseIfInUse(
        await checkMappingVersionSwap(c, {
          mode: 'activate',
          setId: fieldMappingSetId,
          ownerTenantId,
          versionId: fieldMappingVersionId,
          snapshotId,
          activationScope: isRecord(body) ? body.activationScope : undefined,
        })
      );
    }
    return repository.activateFieldMappingVersion(
      ownerTenantId,
      fieldMappingSetId,
      fieldMappingVersionId,
      body as never
    );
  });
}

export async function adminIdentityFieldMappingVersionDeactivateHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.deactivate', async (repository, tenantId) => {
    const fieldMappingSetId = requiredParam(c, 'fieldMappingSetId');
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      tenantId,
      fieldMappingSetId,
      'write'
    );
    const fieldMappingVersionId = requiredParam(c, 'fieldMappingVersionId');
    // Switching off the version in use leaves what names the set without a mapping.
    refuseIfInUse(
      await checkMappingVersionDeactivation(c, {
        setId: fieldMappingSetId,
        ownerTenantId,
        versionId: fieldMappingVersionId,
      })
    );
    return repository.deactivateFieldMappingVersion(
      ownerTenantId,
      fieldMappingSetId,
      fieldMappingVersionId
    );
  });
}

export async function adminIdentityFieldMappingSetRollbackHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.rollback', async (repository, tenantId) => {
    const fieldMappingSetId = requiredParam(c, 'fieldMappingSetId');
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      tenantId,
      fieldMappingSetId,
      'write'
    );
    refuseIfInUse(
      await checkMappingVersionSwap(c, {
        mode: 'rollback',
        setId: fieldMappingSetId,
        ownerTenantId,
      })
    );
    return repository.rollbackFieldMappingSet(ownerTenantId, fieldMappingSetId);
  });
}
