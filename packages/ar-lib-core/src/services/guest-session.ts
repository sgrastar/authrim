import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { Session } from '../durable-objects/SessionStore';
import { getTenantIdFromContext } from '../middleware/request-context';
import { resolveAccountDataContextFromHono } from './runtime-data-context';
import { createAccountAuthContextFromHono } from '../context/hono-context';

export const GUEST_RESUME_COOKIE = 'authrim_guest_resume';

/** Revoke the stored bearer credential before deleting its session. Natural expiry never calls this. */
export async function revokeGuestResumeForSession(
  c: Context<{ Bindings: Env }>,
  session: Session | null
): Promise<void> {
  if (session?.data?.guest_resume_credential !== true) return;
  try {
    const tenantId = getTenantIdFromContext(c);
    const hash = session.data.device_id_hash;
    if (
      session.tenantId !== tenantId ||
      !session.userId ||
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      throw new Error('guest_resume_session_invalid');
    }
    await resolveAccountDataContextFromHono(c, session.userId);
    const { coreAdapter } = createAccountAuthContextFromHono(c, tenantId);
    await coreAdapter.execute(
      'UPDATE guest_devices SET is_active = FALSE WHERE tenant_id = ? AND user_id = ? AND device_id_hash = ?',
      [tenantId, session.userId, hash]
    );
  } catch {
    throw new Error('guest_resume_revocation_failed');
  }
}
