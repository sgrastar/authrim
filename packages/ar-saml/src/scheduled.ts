import type { Env } from '@authrim/ar-lib-core';
import { createAuditLog, createLogger } from '@authrim/ar-lib-core';
import { observeExpiredSAMLIdPLogoutFanoutTransactions } from './idp/slo-state';

interface ScheduledControllerLike {
  scheduledTime?: number;
  cron?: string;
}

export async function handleScheduled(
  controller: ScheduledControllerLike,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const log = createLogger().module('SAML-SCHEDULED');

  try {
    const result = await observeExpiredSAMLIdPLogoutFanoutTransactions(env.STATE_STORE, {
      now: controller.scheduledTime ?? Date.now(),
    });

    if (result.updated === 0) {
      log.debug('SAML logout fanout observation completed without timeouts', {
        scanned: result.scanned,
        cron: controller.cron,
      });
      return;
    }

    log.warn('SAML logout fanout transactions timed out', {
      scanned: result.scanned,
      updated: result.updated,
      cron: controller.cron,
    });

    await Promise.all(
      result.timedOutTransactions.map((transaction) =>
        createAuditLog(env, {
          tenantId: transaction.tenantId,
          userId: 'saml-scheduler',
          action: 'saml.logout_fanout.timeout',
          resource: 'saml_logout_fanout',
          resourceId: transaction.transactionId,
          ipAddress: 'scheduled',
          userAgent: 'authrim-saml-scheduled',
          severity: 'warning',
          metadata: JSON.stringify({
            protocol: 'saml',
            transaction_id: transaction.transactionId,
            session_index: transaction.sessionIndex,
            target_count: transaction.targets.length,
            targets: transaction.targets.map((target) => ({
              sp_entity_id: target.spEntityId,
              status: target.status,
              request_id: target.requestId,
              failure_reason: target.failureReason,
            })),
          }),
        })
      )
    );
  } catch (error) {
    log.error('SAML scheduled observation failed', {}, error as Error);
  }
}
