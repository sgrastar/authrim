import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import type { AuditRuntimePorts } from '@authrim/ar-lib-core/types/audit-runtime-ports';
import type { EventRuntimePorts } from '@authrim/ar-lib-core/types/event-runtime-ports';
import {
  getGlobalHandlerRegistry,
  getGlobalHookRegistry,
} from '@authrim/ar-lib-core/utils/event-dispatcher-factory';

function eventData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('aws_event_payload_unsupported');
  }
  return value as Record<string, unknown>;
}

/** One durable local audit event; external fanout and dispatcher options are unsupported. */
export function createAwsEventRuntimePorts(input: {
  tenantId: string;
  audit: AuditRuntimePorts;
}): EventRuntimePorts {
  return {
    async publish(payload, options) {
      if (
        payload.tenantId !== input.tenantId ||
        !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/u.test(payload.type) ||
        (options && Object.keys(options).length > 0)
      ) {
        throw new Error('aws_event_delivery_unsupported');
      }
      const data = eventData(payload.data);
      const eventId = `evt_${crypto.randomUUID().replace(/-/gu, '')}`;
      const timestamp = Date.now();
      const resourceId =
        (typeof data.clientId === 'string' && data.clientId) ||
        (typeof data.userId === 'string' && data.userId) ||
        'event';
      await input.audit.append({
        id: eventId,
        tenantId: payload.tenantId,
        userId: payload.metadata?.actor?.id ?? 'system',
        action: payload.type,
        resource: payload.type.split('.')[0] ?? 'event',
        resourceId,
        ipAddress: 'system',
        userAgent: 'event-dispatcher',
        metadata: JSON.stringify(data),
        severity: 'info',
        createdAt: timestamp,
      });
      return {
        eventId,
        success: true,
        timestamp,
        delivery: {
          webhooks: { sent: 0, failed: 0, skipped: 0 },
          handlers: { executed: 0, failed: 0, skipped: 0 },
          auditLog: true,
        },
      };
    },
  };
}

/** A limited DR runtime cannot silently skip active webhook or process-local hook policies. */
export async function assertAwsEventPolicyReady(
  db: Pick<DatabaseAdapter, 'queryOne'>,
  tenantId: string
): Promise<void> {
  if (
    getGlobalHandlerRegistry()
      .getAllHandlers()
      .some((handler) => handler.enabled !== false) ||
    getGlobalHookRegistry()
      .getAllBeforeHooks()
      .some((hook) => hook.enabled !== false) ||
    getGlobalHookRegistry()
      .getAllAfterHooks()
      .some((hook) => hook.enabled !== false)
  ) {
    throw new Error('aws_event_internal_handlers_unsupported');
  }
  let active: { id: string } | null;
  try {
    active = await db.queryOne<{ id: string }>(
      'SELECT id FROM webhook_configs WHERE tenant_id = ? AND active = 1 LIMIT 1',
      [tenantId]
    );
  } catch {
    throw new Error('aws_event_policy_unavailable');
  }
  if (active) throw new Error('aws_event_webhooks_unsupported');
}
