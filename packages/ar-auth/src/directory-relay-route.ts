import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { directoryRelayInstanceName } from './directory-relay-client';

const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export async function directoryRelayConnectHandler(c: Context<{ Bindings: Env }>) {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json(
      {
        error: 'websocket_upgrade_required',
      },
      426
    );
  }

  const tenantId = c.req.param('tenantId')?.trim() || '';
  const connectorId = c.req.param('connectorId')?.trim() || '';
  if (!tenantId || tenantId.length > 128 || !CONNECTOR_ID_PATTERN.test(connectorId)) {
    return c.json(
      {
        error: 'invalid_relay_route',
      },
      400
    );
  }

  if (!c.env.DIRECTORY_CONNECTOR_RELAY) {
    return c.json(
      {
        error: 'directory_connector_relay_not_configured',
      },
      503
    );
  }

  const stub = c.env.DIRECTORY_CONNECTOR_RELAY.get(
    c.env.DIRECTORY_CONNECTOR_RELAY.idFromName(
      directoryRelayInstanceName({
        tenantId,
        connectorId,
      })
    )
  );
  return stub.fetch(c.req.raw);
}
