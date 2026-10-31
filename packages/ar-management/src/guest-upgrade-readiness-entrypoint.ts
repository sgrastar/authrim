import { WorkerEntrypoint } from 'cloudflare:workers';
import { isNotificationDeliveryAvailable, type Env } from '@authrim/ar-lib-core';

export interface GuestUpgradeReadinessProps {
  caller: string;
  audience: string;
  environmentId: string;
}

/** Deployment-authenticated, read-only readiness. No credential secrets leave Management. */
export class GuestUpgradeReadinessEntrypoint extends WorkerEntrypoint<
  Env,
  GuestUpgradeReadinessProps
> {
  async read(tenantId: string): Promise<{ tenantId: string; email: boolean }> {
    const props = this.ctx.props;
    if (
      props?.caller !== 'ar-userinfo' ||
      props.audience !== 'authrim-guest-upgrade-readiness-v1' ||
      !this.env.AUTHRIM_ENVIRONMENT_NAME ||
      props.environmentId !== this.env.AUTHRIM_ENVIRONMENT_NAME ||
      typeof tenantId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(tenantId)
    ) {
      throw new Error('guest_upgrade_readiness_unauthorized');
    }
    return {
      tenantId,
      email:
        new TextEncoder().encode(this.env.OTP_HMAC_SECRET ?? '').length >= 32 &&
        (await isNotificationDeliveryAvailable(this.env, { owner: 'tenant', tenantId })),
    };
  }
}
