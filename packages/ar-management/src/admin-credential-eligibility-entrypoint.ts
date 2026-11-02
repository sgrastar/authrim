import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  evaluateAdminCredentialEligibility,
  requireDedicatedAdminDatabaseAdapter,
  type AdminCredentialEligibilityServiceBinding,
  type Env,
} from '@authrim/ar-lib-core';

export interface AdminCredentialEligibilityProps {
  caller: string;
  environmentId: string;
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

/**
 * Deployment-authenticated, read-only eligibility check for ar-vc's issuance-time re-check
 * (admin credential design D4). The Admin DB stays inside Management; only the decision and the
 * credential claims leave it.
 */
export class AdminCredentialEligibilityEntrypoint
  extends WorkerEntrypoint<Env, AdminCredentialEligibilityProps>
  implements AdminCredentialEligibilityServiceBinding
{
  async checkAdminCredentialEligibility(input: {
    tenantId: string;
    adminUserId: string;
  }): Promise<{ eligible: boolean; email?: string; name?: string | null }> {
    const props = this.ctx.props;
    if (
      props?.caller !== 'ar-vc' ||
      !this.env.AUTHRIM_ENVIRONMENT_NAME ||
      props.environmentId !== this.env.AUTHRIM_ENVIRONMENT_NAME ||
      typeof input?.tenantId !== 'string' ||
      !ID_PATTERN.test(input.tenantId) ||
      typeof input.adminUserId !== 'string' ||
      !ID_PATTERN.test(input.adminUserId)
    ) {
      throw new Error('admin_credential_eligibility_unauthorized');
    }
    const adapter = requireDedicatedAdminDatabaseAdapter(this.env, 'admin-credential-eligibility');
    const result = await evaluateAdminCredentialEligibility(adapter, {
      tenantId: input.tenantId,
      adminUserId: input.adminUserId,
      now: Date.now(),
    });
    return result.eligible
      ? { eligible: true, email: result.email, name: result.name }
      : { eligible: false };
  }
}
