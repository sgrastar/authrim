import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { registerAdminResourcePermissionMiddleware } from '../admin-resource-permissions';

function createApp(permissions: string[]) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminAuth?: AdminAuthContext };
  }>();

  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'machine_access_token',
      actorType: 'machine',
      tenantId: 'tenant-a',
      roles: [],
      permissions,
      hierarchyLevel: 0,
      mfaVerified: false,
    });
    await next();
  });

  registerAdminResourcePermissionMiddleware(app);

  app.get('/api/admin/users', (c) => c.json({ ok: true }));
  app.delete('/api/admin/users/user-1', (c) => c.json({ ok: true }));
  app.post('/api/admin/users/user-1/anonymize', (c) => c.json({ ok: true }));
  app.post('/api/admin/users/user-1/roles', (c) => c.json({ ok: true }));
  app.get('/api/admin/settings', (c) => c.json({ ok: true }));
  app.put('/api/admin/settings', (c) => c.json({ ok: true }));
  app.get('/api/admin/sessions/session-1', (c) => c.json({ ok: true }));
  app.delete('/api/admin/sessions/session-1', (c) => c.json({ ok: true }));
  app.delete('/api/admin/users/user-1/sessions', (c) => c.json({ ok: true }));
  app.get('/api/admin/users/user-1/device-secrets', (c) => c.json({ ok: true }));
  app.delete('/api/admin/users/user-1/device-secrets', (c) => c.json({ ok: true }));
  app.get('/api/admin/device-secrets/device-1', (c) => c.json({ ok: true }));
  app.delete('/api/admin/device-secrets/device-1', (c) => c.json({ ok: true }));
  app.post('/api/admin/device-secrets/cleanup', (c) => c.json({ ok: true }));
  app.get('/api/admin/signing-keys/status', (c) => c.json({ ok: true }));
  app.post('/api/admin/signing-keys/rotate', (c) => c.json({ ok: true }));
  app.post('/api/admin/signing-keys/emergency-rotate', (c) => c.json({ ok: true }));
  app.get('/api/admin/scim-tokens', (c) => c.json({ ok: true }));
  app.post('/api/admin/scim-tokens', (c) => c.json({ ok: true }));
  app.delete('/api/admin/scim-tokens/token-hash', (c) => c.json({ ok: true }));
  app.get('/api/admin/iat-tokens', (c) => c.json({ ok: true }));
  app.post('/api/admin/iat-tokens', (c) => c.json({ ok: true }));
  app.delete('/api/admin/iat-tokens/token-hash', (c) => c.json({ ok: true }));
  app.get('/api/admin/check-api-keys', (c) => c.json({ ok: true }));
  app.post('/api/admin/check-api-keys', (c) => c.json({ ok: true }));
  app.post('/api/admin/check-api-keys/key-1/rotate', (c) => c.json({ ok: true }));
  app.get('/api/admin/custom-claims', (c) => c.json({ ok: true }));
  app.post('/api/admin/custom-claims', (c) => c.json({ ok: true }));
  app.patch('/api/admin/custom-claims/schema-1/rename', (c) => c.json({ ok: true }));
  app.get('/api/admin/token-claim-rules', (c) => c.json({ ok: true }));
  app.post('/api/admin/token-claim-rules', (c) => c.json({ ok: true }));
  app.post('/api/admin/token-claim-rules/rule-1/test', (c) => c.json({ ok: true }));
  app.get('/api/admin/attributes', (c) => c.json({ ok: true }));
  app.post('/api/admin/attributes', (c) => c.json({ ok: true }));
  app.delete('/api/admin/attributes/attribute-1', (c) => c.json({ ok: true }));
  app.get('/api/admin/org-domain-mappings', (c) => c.json({ ok: true }));
  app.post('/api/admin/org-domain-mappings', (c) => c.json({ ok: true }));
  app.post('/api/admin/org-domain-mappings/verify', (c) => c.json({ ok: true }));
  app.get('/api/admin/external-providers', (c) => c.json({ ok: true }));
  app.post('/api/admin/external-providers', (c) => c.json({ ok: true }));
  app.post('/api/admin/external-providers/discover-oidc', (c) => c.json({ ok: true }));
  app.delete('/api/admin/external-providers/provider-1', (c) => c.json({ ok: true }));
  app.get('/api/admin/external-token-refresh/config', (c) => c.json({ ok: true }));
  app.put('/api/admin/external-token-refresh/config', (c) => c.json({ ok: true }));
  app.post('/api/admin/external-token-refresh/run', (c) => c.json({ ok: true }));

  return app;
}

describe('admin resource permission middleware', () => {
  it('rejects destructive user operations with users read permission only', async () => {
    const app = createApp([ADMIN_PERMISSIONS.USERS_READ]);

    const list = await app.request('/api/admin/users');
    const deleteUser = await app.request('/api/admin/users/user-1', { method: 'DELETE' });
    const anonymize = await app.request('/api/admin/users/user-1/anonymize', { method: 'POST' });

    expect(list.status).toBe(200);
    expect(deleteUser.status).toBe(403);
    expect(anonymize.status).toBe(403);
  });

  it('allows destructive user operations with users delete permission', async () => {
    const app = createApp([ADMIN_PERMISSIONS.USERS_DELETE]);

    const deleteUser = await app.request('/api/admin/users/user-1', { method: 'DELETE' });
    const anonymize = await app.request('/api/admin/users/user-1/anonymize', { method: 'POST' });

    expect(deleteUser.status).toBe(200);
    expect(anonymize.status).toBe(200);
  });

  it('does not double-gate RBAC user subresources with users permissions', async () => {
    const app = createApp([]);
    const response = await app.request('/api/admin/users/user-1/roles', { method: 'POST' });

    expect(response.status).toBe(200);
  });

  it('requires settings write permission for settings updates', async () => {
    const readOnly = createApp([ADMIN_PERMISSIONS.SETTINGS_READ]);
    const writer = createApp([ADMIN_PERMISSIONS.SETTINGS_WRITE]);

    const read = await readOnly.request('/api/admin/settings');
    const denied = await readOnly.request('/api/admin/settings', { method: 'PUT' });
    const allowed = await writer.request('/api/admin/settings', { method: 'PUT' });

    expect(read.status).toBe(200);
    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  it('requires sessions revoke permission for session revocation', async () => {
    const readOnly = createApp([ADMIN_PERMISSIONS.SESSIONS_READ]);
    const revoker = createApp([ADMIN_PERMISSIONS.SESSIONS_REVOKE]);

    const read = await readOnly.request('/api/admin/sessions/session-1');
    const deniedSession = await readOnly.request('/api/admin/sessions/session-1', {
      method: 'DELETE',
    });
    const deniedUserSessions = await createApp([ADMIN_PERMISSIONS.USERS_DELETE]).request(
      '/api/admin/users/user-1/sessions',
      { method: 'DELETE' }
    );
    const allowed = await revoker.request('/api/admin/users/user-1/sessions', {
      method: 'DELETE',
    });

    expect(read.status).toBe(200);
    expect(deniedSession.status).toBe(403);
    expect(deniedUserSessions.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  it('requires sessions permissions for native SSO device secret management', async () => {
    const readOnly = createApp([ADMIN_PERMISSIONS.SESSIONS_READ]);
    const revoker = createApp([ADMIN_PERMISSIONS.SESSIONS_REVOKE]);

    const readUserDevices = await readOnly.request('/api/admin/users/user-1/device-secrets');
    const deniedRevokeAll = await readOnly.request('/api/admin/users/user-1/device-secrets', {
      method: 'DELETE',
    });
    const deniedDirectRevoke = await readOnly.request('/api/admin/device-secrets/device-1', {
      method: 'DELETE',
    });
    const allowedRevokeAll = await revoker.request('/api/admin/users/user-1/device-secrets', {
      method: 'DELETE',
    });
    const allowedDirectRevoke = await revoker.request('/api/admin/device-secrets/device-1', {
      method: 'DELETE',
    });
    const allowedCleanup = await revoker.request('/api/admin/device-secrets/cleanup', {
      method: 'POST',
    });

    expect(readUserDevices.status).toBe(200);
    expect(deniedRevokeAll.status).toBe(403);
    expect(deniedDirectRevoke.status).toBe(403);
    expect(allowedRevokeAll.status).toBe(200);
    expect(allowedDirectRevoke.status).toBe(200);
    expect(allowedCleanup.status).toBe(200);
  });

  it('requires security write permission for signing key rotation and SCIM token issuance', async () => {
    const readOnly = createApp([ADMIN_PERMISSIONS.SECURITY_READ]);
    const writer = createApp([ADMIN_PERMISSIONS.SECURITY_WRITE]);

    const keyStatus = await readOnly.request('/api/admin/signing-keys/status');
    const deniedRotate = await readOnly.request('/api/admin/signing-keys/rotate', {
      method: 'POST',
    });
    const deniedEmergencyRotate = await readOnly.request(
      '/api/admin/signing-keys/emergency-rotate',
      { method: 'POST' }
    );
    const scimList = await readOnly.request('/api/admin/scim-tokens');
    const deniedScimCreate = await readOnly.request('/api/admin/scim-tokens', {
      method: 'POST',
    });
    const allowedRotate = await writer.request('/api/admin/signing-keys/rotate', {
      method: 'POST',
    });
    const allowedScimCreate = await writer.request('/api/admin/scim-tokens', {
      method: 'POST',
    });

    expect(keyStatus.status).toBe(200);
    expect(deniedRotate.status).toBe(403);
    expect(deniedEmergencyRotate.status).toBe(403);
    expect(scimList.status).toBe(200);
    expect(deniedScimCreate.status).toBe(403);
    expect(allowedRotate.status).toBe(200);
    expect(allowedScimCreate.status).toBe(200);
  });

  it('requires security write permission for policy check API key changes', async () => {
    const readOnly = createApp([ADMIN_PERMISSIONS.SECURITY_READ]);
    const writer = createApp([ADMIN_PERMISSIONS.SECURITY_WRITE]);

    const list = await readOnly.request('/api/admin/check-api-keys');
    const deniedCreate = await readOnly.request('/api/admin/check-api-keys', { method: 'POST' });
    const deniedRotate = await readOnly.request('/api/admin/check-api-keys/key-1/rotate', {
      method: 'POST',
    });
    const allowedCreate = await writer.request('/api/admin/check-api-keys', { method: 'POST' });
    const allowedRotate = await writer.request('/api/admin/check-api-keys/key-1/rotate', {
      method: 'POST',
    });

    expect(list.status).toBe(200);
    expect(deniedCreate.status).toBe(403);
    expect(deniedRotate.status).toBe(403);
    expect(allowedCreate.status).toBe(200);
    expect(allowedRotate.status).toBe(200);
  });

  it('requires client write permission for initial access token management', async () => {
    const readOnly = createApp([ADMIN_PERMISSIONS.CLIENTS_READ]);
    const writer = createApp([ADMIN_PERMISSIONS.CLIENTS_WRITE]);

    const list = await readOnly.request('/api/admin/iat-tokens');
    const deniedCreate = await readOnly.request('/api/admin/iat-tokens', { method: 'POST' });
    const deniedRevoke = await readOnly.request('/api/admin/iat-tokens/token-hash', {
      method: 'DELETE',
    });
    const allowedCreate = await writer.request('/api/admin/iat-tokens', { method: 'POST' });
    const allowedRevoke = await writer.request('/api/admin/iat-tokens/token-hash', {
      method: 'DELETE',
    });

    expect(list.status).toBe(200);
    expect(deniedCreate.status).toBe(403);
    expect(deniedRevoke.status).toBe(403);
    expect(allowedCreate.status).toBe(200);
    expect(allowedRevoke.status).toBe(200);
  });

  it('requires settings write permission for token and custom claim control planes', async () => {
    const readOnly = createApp([ADMIN_PERMISSIONS.SETTINGS_READ]);
    const writer = createApp([ADMIN_PERMISSIONS.SETTINGS_WRITE]);

    const customClaims = await readOnly.request('/api/admin/custom-claims');
    const deniedCustomClaimCreate = await readOnly.request('/api/admin/custom-claims', {
      method: 'POST',
    });
    const deniedCustomClaimRename = await readOnly.request(
      '/api/admin/custom-claims/schema-1/rename',
      { method: 'PATCH' }
    );
    const tokenClaimRules = await readOnly.request('/api/admin/token-claim-rules');
    const deniedTokenClaimCreate = await readOnly.request('/api/admin/token-claim-rules', {
      method: 'POST',
    });
    const deniedTokenClaimTest = await readOnly.request(
      '/api/admin/token-claim-rules/rule-1/test',
      {
        method: 'POST',
      }
    );
    const allowedCustomClaimCreate = await writer.request('/api/admin/custom-claims', {
      method: 'POST',
    });
    const allowedTokenClaimCreate = await writer.request('/api/admin/token-claim-rules', {
      method: 'POST',
    });

    expect(customClaims.status).toBe(200);
    expect(deniedCustomClaimCreate.status).toBe(403);
    expect(deniedCustomClaimRename.status).toBe(403);
    expect(tokenClaimRules.status).toBe(200);
    expect(deniedTokenClaimCreate.status).toBe(403);
    expect(deniedTokenClaimTest.status).toBe(403);
    expect(allowedCustomClaimCreate.status).toBe(200);
    expect(allowedTokenClaimCreate.status).toBe(200);
  });

  it('requires users write permission for ABAC attribute changes', async () => {
    const readOnly = createApp([ADMIN_PERMISSIONS.USERS_READ]);
    const writer = createApp([ADMIN_PERMISSIONS.USERS_WRITE]);

    const list = await readOnly.request('/api/admin/attributes');
    const deniedCreate = await readOnly.request('/api/admin/attributes', { method: 'POST' });
    const deniedDelete = await readOnly.request('/api/admin/attributes/attribute-1', {
      method: 'DELETE',
    });
    const allowedCreate = await writer.request('/api/admin/attributes', { method: 'POST' });
    const allowedDelete = await writer.request('/api/admin/attributes/attribute-1', {
      method: 'DELETE',
    });

    expect(list.status).toBe(200);
    expect(deniedCreate.status).toBe(403);
    expect(deniedDelete.status).toBe(403);
    expect(allowedCreate.status).toBe(200);
    expect(allowedDelete.status).toBe(200);
  });

  it('requires settings write permission for organization domain mappings', async () => {
    const readOnly = createApp([ADMIN_PERMISSIONS.SETTINGS_READ]);
    const writer = createApp([ADMIN_PERMISSIONS.SETTINGS_WRITE]);

    const list = await readOnly.request('/api/admin/org-domain-mappings');
    const deniedCreate = await readOnly.request('/api/admin/org-domain-mappings', {
      method: 'POST',
    });
    const deniedVerify = await readOnly.request('/api/admin/org-domain-mappings/verify', {
      method: 'POST',
    });
    const allowedCreate = await writer.request('/api/admin/org-domain-mappings', {
      method: 'POST',
    });

    expect(list.status).toBe(200);
    expect(deniedCreate.status).toBe(403);
    expect(deniedVerify.status).toBe(403);
    expect(allowedCreate.status).toBe(200);
  });

  it('requires external provider permissions for provider and token-refresh changes', async () => {
    const providerReader = createApp([ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_READ]);
    const providerWriter = createApp([ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_WRITE]);
    const providerDeleter = createApp([ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_DELETE]);
    const refreshReader = createApp([ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_READ]);
    const refreshWriter = createApp([ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE]);
    const refreshRunner = createApp([ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_RUN]);

    const providers = await providerReader.request('/api/admin/external-providers');
    const deniedProviderCreate = await providerReader.request('/api/admin/external-providers', {
      method: 'POST',
    });
    const deniedProviderDiscover = await providerReader.request(
      '/api/admin/external-providers/discover-oidc',
      { method: 'POST' }
    );
    const deniedProviderDelete = await providerWriter.request(
      '/api/admin/external-providers/provider-1',
      { method: 'DELETE' }
    );
    const allowedProviderCreate = await providerWriter.request('/api/admin/external-providers', {
      method: 'POST',
    });
    const allowedProviderDelete = await providerDeleter.request(
      '/api/admin/external-providers/provider-1',
      { method: 'DELETE' }
    );
    const refreshConfig = await refreshReader.request('/api/admin/external-token-refresh/config');
    const deniedRefreshUpdate = await refreshReader.request(
      '/api/admin/external-token-refresh/config',
      { method: 'PUT' }
    );
    const deniedRefreshRun = await refreshWriter.request('/api/admin/external-token-refresh/run', {
      method: 'POST',
    });
    const allowedRefreshUpdate = await refreshWriter.request(
      '/api/admin/external-token-refresh/config',
      { method: 'PUT' }
    );
    const allowedRefreshRun = await refreshRunner.request('/api/admin/external-token-refresh/run', {
      method: 'POST',
    });

    expect(providers.status).toBe(200);
    expect(deniedProviderCreate.status).toBe(403);
    expect(deniedProviderDiscover.status).toBe(403);
    expect(deniedProviderDelete.status).toBe(403);
    expect(allowedProviderCreate.status).toBe(200);
    expect(allowedProviderDelete.status).toBe(200);
    expect(refreshConfig.status).toBe(200);
    expect(deniedRefreshUpdate.status).toBe(403);
    expect(deniedRefreshRun.status).toBe(403);
    expect(allowedRefreshUpdate.status).toBe(200);
    expect(allowedRefreshRun.status).toBe(200);
  });
});
