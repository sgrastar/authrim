/**
 * Tests written against direct createAuditLog(env, entry) writes assert on that entry. Those
 * modules now record admin operations with recordAdminOperationAudit /
 * recordAdminOperationAuditFromEnv, which this replaces in those tests: each call is forwarded
 * to the (usually mocked) createAuditLog with the entry the older code wrote, so the tests keep
 * checking what a handler records, and a rejection still reaches the handler. The helpers
 * themselves are tested in admin-operation-audit.test.ts and
 * admin-operation-audit.integration.test.ts.
 *
 *   vi.mock('../admin-operation-audit', () => import('./helpers/legacy-direct-audit-shim'));
 */
import type { Context } from 'hono';
import { createAuditLog, type AdminAuthContext, type Env } from '@authrim/ar-lib-core';
import type { AdminOperationAuditInput } from '../../admin-operation-audit';

function routedTenant(c: Context<{ Bindings: Env }>): string {
  const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId');
  return typeof tenantId === 'string' ? tenantId : '';
}

export async function recordAdminOperationAudit(
  c: Context<{ Bindings: Env }>,
  input: AdminOperationAuditInput
): Promise<string> {
  const admin = (c as unknown as { get(key: string): unknown }).get('adminAuth') as
    | AdminAuthContext
    | undefined;
  await createAuditLog(c.env, {
    tenantId: input.tenantId ?? routedTenant(c),
    userId: admin?.userId ?? 'unknown',
    action: input.action,
    resource: input.resourceType,
    resourceId: input.resourceId ?? '',
    ipAddress: c.req.header('CF-Connecting-IP') ?? 'unknown',
    userAgent: c.req.header('User-Agent') ?? 'unknown',
    metadata: JSON.stringify(input.metadata ?? {}),
    severity: input.severity ?? 'info',
  });
  return `audit-${input.action}`;
}

export { recordAdminOperationAuditFromEnv } from './legacy-admin-audit-shim';
