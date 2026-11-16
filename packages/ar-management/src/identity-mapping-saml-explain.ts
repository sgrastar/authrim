import type { Context } from 'hono';
import { ensureAdminDatabaseAdapter, getTenantIdFromContext, type Env } from '@authrim/ar-lib-core';
import { explainSAMLReleaseFixture } from '@authrim/ar-saml/release-explain';
import { isRecord } from './identity-mapping-control-plane';
import { findTestUser } from './identity-mapping-test-users';

export async function explainSAMLRelease(c: Context<{ Bindings: Env }>, body: unknown) {
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => !['sp_entity_id', 'subject', 'consent'].includes(key)) ||
    typeof body.sp_entity_id !== 'string' ||
    !body.sp_entity_id.trim() ||
    body.sp_entity_id.length > 2048 ||
    !isRecord(body.subject) ||
    body.subject.kind !== 'test_user' ||
    typeof body.subject.id !== 'string' ||
    body.subject.id.length > 64 ||
    Object.keys(body.subject).some((key) => key !== 'kind' && key !== 'id') ||
    (body.consent !== undefined &&
      body.consent !== 'all' &&
      body.consent !== 'none' &&
      body.consent !== 'required')
  ) {
    return c.json(
      {
        error: 'invalid_request',
        error_description:
          'Expected { sp_entity_id, subject: { kind: "test_user", id }, consent?: "all" | "none" | "required" }',
      },
      400
    );
  }
  const tenantId = getTenantIdFromContext(c);
  const admin = ensureAdminDatabaseAdapter(c.env, 'identity-mapping-saml-explain');
  if (!admin) return c.json({ error: 'temporarily_unavailable' }, 503);
  try {
    const user = await findTestUser(admin, tenantId, body.subject.id);
    if (!user) return c.json({ error: 'not_found', error_description: 'test user not found' }, 404);
    const result = await explainSAMLReleaseFixture({
      env: c.env,
      tenantId,
      spEntityId: body.sp_entity_id,
      user,
      consent: body.consent ?? 'all',
    });
    return c.json(result.body, result.status);
  } catch {
    return c.json(
      { error: 'internal_error', error_description: 'The SAML release could not be explained' },
      500
    );
  }
}
