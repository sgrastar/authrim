import type { Env } from '@authrim/ar-lib-core';
import { createAuditLog, createLogger } from '@authrim/ar-lib-core';
import { pollSAMLMetadata } from './admin/metadata-polling';
import { observeExpiredSAMLIdPLogoutFanoutTransactions } from './idp/slo-state';

interface ScheduledControllerLike {
  scheduledTime?: number;
  cron?: string;
}

const LOGOUT_OBSERVATION_CURSOR_KEY = 'saml:logout-fanout:observation-cursor';
const MAX_LOGOUT_OBSERVATIONS_PER_RUN = 100;
const MAX_LOGOUT_AUDIT_CONCURRENCY = 10;

async function runBounded<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  for (let index = 0; index < values.length; index += concurrency) {
    await Promise.allSettled(values.slice(index, index + concurrency).map(operation));
  }
}

export async function handleScheduled(
  controller: ScheduledControllerLike,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const log = createLogger().module('SAML-SCHEDULED');
  const now = controller.scheduledTime ?? Date.now();

  const observeLogoutFanout = async (): Promise<void> => {
    try {
      const cursor = await env.STATE_STORE.get(LOGOUT_OBSERVATION_CURSOR_KEY);
      const result = await observeExpiredSAMLIdPLogoutFanoutTransactions(env.STATE_STORE, {
        now,
        cursor: cursor ?? undefined,
        maxRecords: MAX_LOGOUT_OBSERVATIONS_PER_RUN,
      });
      if (result.nextCursor) {
        await env.STATE_STORE.put(LOGOUT_OBSERVATION_CURSOR_KEY, result.nextCursor);
      } else {
        await env.STATE_STORE.delete(LOGOUT_OBSERVATION_CURSOR_KEY);
      }

      if (result.updated === 0) {
        log.debug('SAML logout fanout observation completed without timeouts', {
          scanned: result.scanned,
          cron: controller.cron,
        });
      } else {
        log.warn('SAML logout fanout transactions timed out', {
          scanned: result.scanned,
          updated: result.updated,
          cron: controller.cron,
        });

        await runBounded(result.timedOutTransactions, MAX_LOGOUT_AUDIT_CONCURRENCY, (transaction) =>
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
        );
      }
    } catch (error) {
      log.error('SAML scheduled observation failed', {}, error as Error);
    }
  };

  const pollMetadata = async (): Promise<void> => {
    try {
      const result = await pollSAMLMetadata(env, now);
      log.info('SAML metadata polling completed', {
        ...result,
        cron: controller.cron,
      });
    } catch (error) {
      log.error('SAML metadata polling failed', {}, error as Error);
    }
  };

  // These maintenance jobs are independent. Start both immediately so a large logout backlog
  // cannot delay certificate, expiry, or entity-removal synchronization.
  await Promise.all([observeLogoutFanout(), pollMetadata()]);
}
