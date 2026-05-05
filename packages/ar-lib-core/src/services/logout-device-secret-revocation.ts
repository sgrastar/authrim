import type { DatabaseAdapter } from '../db/adapter';

export type DeviceSecretLogoutScope = 'local' | 'group' | 'global';

export const DEFAULT_DEVICE_SECRET_LOGOUT_SCOPE: DeviceSecretLogoutScope = 'group';

export interface RevokeDeviceSecretsForLogoutScopeInput {
  adapter: DatabaseAdapter;
  tenantId?: string;
  sessionIds: string[];
  userId?: string;
  clientId?: string;
  trustGroupId?: string;
  scope?: DeviceSecretLogoutScope | string | null;
  reason?: string;
  callerAuthMode?: string;
}

export interface RevokeDeviceSecretsForLogoutScopeResult {
  scope: DeviceSecretLogoutScope;
  tenantId: string;
  userId?: string;
  clientId?: string;
  trustGroupId?: string;
  sessionIds: string[];
  revokedDeviceSecrets: number;
  revokedInstallations: number;
  matchedInstallations: number;
  callerAuthMode?: string;
}

interface InstallationScopeRow {
  id: string;
  user_id: string;
  client_id?: string | null;
  trust_group_id?: string | null;
  linked_device_secret_id?: string | null;
  session_id?: string | null;
}

interface DeviceSecretScopeRow {
  id: string;
  user_id: string;
  client_id?: string | null;
  trust_group_id?: string | null;
  installation_id?: string | null;
  session_id: string;
}

interface ScopePredicate {
  where: string[];
  params: unknown[];
}

function uniq(values: Array<string | undefined | null>): string[] {
  return Array.from(
    new Set(
      values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );
}

function placeholders(values: string[]): string {
  return values.map(() => '?').join(', ');
}

export function normalizeDeviceSecretLogoutScope(
  scope: DeviceSecretLogoutScope | string | null | undefined
): DeviceSecretLogoutScope {
  return scope === 'local' || scope === 'group' || scope === 'global'
    ? scope
    : DEFAULT_DEVICE_SECRET_LOGOUT_SCOPE;
}

function isMissingInstallationTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('device_installations') ||
    message.includes('no such table') ||
    message.includes('relation "device_installations" does not exist')
  );
}

function isMissingDeviceSecretScopeColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('client_id') ||
    message.includes('trust_group_id') ||
    message.includes('installation_id') ||
    message.includes('source_installation_id') ||
    message.includes('source_client_id')
  );
}

async function findInstallationAnchors(input: {
  adapter: DatabaseAdapter;
  tenantId: string;
  sessionIds: string[];
  clientId?: string;
}): Promise<InstallationScopeRow[]> {
  if (input.sessionIds.length === 0) {
    return [];
  }

  const params: unknown[] = [input.tenantId, ...input.sessionIds];
  let sql = `
    SELECT id, user_id, client_id, trust_group_id, linked_device_secret_id, session_id
    FROM device_installations
    WHERE tenant_id = ?
      AND session_id IN (${placeholders(input.sessionIds)})
      AND is_active = 1
      AND revoked_at IS NULL
  `;

  if (input.clientId) {
    sql += ' AND client_id = ?';
    params.push(input.clientId);
  }

  try {
    return await input.adapter.query<InstallationScopeRow>(sql, params);
  } catch (error) {
    if (isMissingInstallationTableError(error)) {
      return [];
    }
    throw error;
  }
}

async function findDeviceSecretAnchors(input: {
  adapter: DatabaseAdapter;
  tenantId: string;
  sessionIds: string[];
  clientId?: string;
}): Promise<DeviceSecretScopeRow[]> {
  if (input.sessionIds.length === 0) {
    return [];
  }

  const params: unknown[] = [input.tenantId, ...input.sessionIds];
  let sql = `
    SELECT id, user_id, client_id, trust_group_id, installation_id, session_id
    FROM device_secrets
    WHERE tenant_id = ?
      AND session_id IN (${placeholders(input.sessionIds)})
      AND is_active = 1
      AND revoked_at IS NULL
  `;

  if (input.clientId) {
    sql += ' AND client_id = ?';
    params.push(input.clientId);
  }

  try {
    return await input.adapter.query<DeviceSecretScopeRow>(sql, params);
  } catch (error) {
    if (!isMissingDeviceSecretScopeColumnError(error)) {
      throw error;
    }

    const fallbackSql = `
      SELECT id, user_id, session_id
      FROM device_secrets
      WHERE tenant_id = ?
        AND session_id IN (${placeholders(input.sessionIds)})
        AND is_active = 1
        AND revoked_at IS NULL
    `;
    return input.adapter.query<DeviceSecretScopeRow>(fallbackSql, [
      input.tenantId,
      ...input.sessionIds,
    ]);
  }
}

function buildInstallationPredicate(input: {
  scope: DeviceSecretLogoutScope;
  tenantId: string;
  sessionIds: string[];
  userId?: string;
  clientId?: string;
  trustGroupId?: string;
}): ScopePredicate | null {
  const where = ['tenant_id = ?', 'is_active = 1', 'revoked_at IS NULL'];
  const params: unknown[] = [input.tenantId];

  if (input.scope === 'global' && input.userId) {
    where.push('user_id = ?');
    params.push(input.userId);
    return { where, params };
  }

  if (input.scope === 'group' && input.userId && input.trustGroupId) {
    where.push('user_id = ?', 'trust_group_id = ?');
    params.push(input.userId, input.trustGroupId);
    return { where, params };
  }

  if (input.scope === 'group' && input.userId && input.clientId) {
    where.push('user_id = ?', 'client_id = ?');
    params.push(input.userId, input.clientId);
    return { where, params };
  }

  if (input.sessionIds.length === 0) {
    return null;
  }

  where.push(`session_id IN (${placeholders(input.sessionIds)})`);
  params.push(...input.sessionIds);

  if (input.clientId) {
    where.push('client_id = ?');
    params.push(input.clientId);
  }

  return { where, params };
}

function buildDeviceSecretPredicate(input: {
  scope: DeviceSecretLogoutScope;
  tenantId: string;
  sessionIds: string[];
  userId?: string;
  clientId?: string;
  trustGroupId?: string;
  allowScopeColumns: boolean;
}): ScopePredicate | null {
  const where = ['tenant_id = ?', 'is_active = 1', 'revoked_at IS NULL'];
  const params: unknown[] = [input.tenantId];

  if (input.scope === 'global' && input.userId) {
    where.push('user_id = ?');
    params.push(input.userId);
    return { where, params };
  }

  if (input.allowScopeColumns && input.scope === 'group' && input.userId && input.trustGroupId) {
    where.push('user_id = ?', 'trust_group_id = ?');
    params.push(input.userId, input.trustGroupId);
    return { where, params };
  }

  if (input.allowScopeColumns && input.scope === 'group' && input.userId && input.clientId) {
    where.push('user_id = ?', 'client_id = ?');
    params.push(input.userId, input.clientId);
    return { where, params };
  }

  if (input.sessionIds.length === 0) {
    return null;
  }

  where.push(`session_id IN (${placeholders(input.sessionIds)})`);
  params.push(...input.sessionIds);

  if (input.allowScopeColumns && input.clientId) {
    where.push('client_id = ?');
    params.push(input.clientId);
  }

  return { where, params };
}

async function findInstallationsByPredicate(
  adapter: DatabaseAdapter,
  predicate: ScopePredicate | null
): Promise<InstallationScopeRow[]> {
  if (!predicate) {
    return [];
  }

  try {
    return await adapter.query<InstallationScopeRow>(
      `
        SELECT id, user_id, client_id, trust_group_id, linked_device_secret_id, session_id
        FROM device_installations
        WHERE ${predicate.where.join(' AND ')}
      `,
      predicate.params
    );
  } catch (error) {
    if (isMissingInstallationTableError(error)) {
      return [];
    }
    throw error;
  }
}

async function revokeInstallationsByPredicate(input: {
  adapter: DatabaseAdapter;
  predicate: ScopePredicate | null;
  reason: string;
}): Promise<number> {
  if (!input.predicate) {
    return 0;
  }

  try {
    const now = Date.now();
    const result = await input.adapter.execute(
      `
        UPDATE device_installations
        SET revoked_at = ?, revoke_reason = ?, updated_at = ?
        WHERE ${input.predicate.where.join(' AND ')}
      `,
      [now, input.reason, now, ...input.predicate.params]
    );
    return result.rowsAffected;
  } catch (error) {
    if (isMissingInstallationTableError(error)) {
      return 0;
    }
    throw error;
  }
}

async function revokeDeviceSecretsByIds(input: {
  adapter: DatabaseAdapter;
  ids: Array<string | null | undefined>;
  reason: string;
}): Promise<number> {
  const ids = uniq(input.ids);
  if (ids.length === 0) {
    return 0;
  }

  const now = Date.now();
  const result = await input.adapter.execute(
    `
      UPDATE device_secrets
      SET revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE id IN (${placeholders(ids)})
        AND is_active = 1
        AND revoked_at IS NULL
    `,
    [now, input.reason, now, ...ids]
  );
  return result.rowsAffected;
}

async function revokeDeviceSecretsByPredicate(input: {
  adapter: DatabaseAdapter;
  predicate: ScopePredicate | null;
  reason: string;
}): Promise<number> {
  if (!input.predicate) {
    return 0;
  }

  const now = Date.now();
  const result = await input.adapter.execute(
    `
      UPDATE device_secrets
      SET revoked_at = ?, revoke_reason = ?, updated_at = ?
      WHERE ${input.predicate.where.join(' AND ')}
    `,
    [now, input.reason, now, ...input.predicate.params]
  );
  return result.rowsAffected;
}

export async function revokeDeviceSecretsForLogoutScope(
  input: RevokeDeviceSecretsForLogoutScopeInput
): Promise<RevokeDeviceSecretsForLogoutScopeResult> {
  const tenantId = input.tenantId ?? 'default';
  const sessionIds = uniq(input.sessionIds);
  const scope = normalizeDeviceSecretLogoutScope(input.scope);
  const reason = input.reason ?? 'logout';

  if (sessionIds.length === 0 && !input.userId) {
    return {
      scope,
      tenantId,
      sessionIds,
      revokedDeviceSecrets: 0,
      revokedInstallations: 0,
      matchedInstallations: 0,
      callerAuthMode: input.callerAuthMode,
    };
  }

  const [installationAnchors, deviceSecretAnchors] = await Promise.all([
    findInstallationAnchors({
      adapter: input.adapter,
      tenantId,
      sessionIds,
      clientId: input.clientId,
    }),
    findDeviceSecretAnchors({
      adapter: input.adapter,
      tenantId,
      sessionIds,
      clientId: input.clientId,
    }),
  ]);

  const anchorInstallation = installationAnchors[0];
  const anchorDeviceSecret = deviceSecretAnchors[0];
  const userId = input.userId ?? anchorInstallation?.user_id ?? anchorDeviceSecret?.user_id;
  const clientId =
    input.clientId ?? anchorInstallation?.client_id ?? anchorDeviceSecret?.client_id ?? undefined;
  const trustGroupId =
    input.trustGroupId ??
    installationAnchors.find((row) => row.trust_group_id)?.trust_group_id ??
    deviceSecretAnchors.find((row) => row.trust_group_id)?.trust_group_id ??
    undefined;

  const installationPredicate = buildInstallationPredicate({
    scope,
    tenantId,
    sessionIds,
    userId,
    clientId,
    trustGroupId,
  });

  const matchedInstallations = await findInstallationsByPredicate(
    input.adapter,
    installationPredicate
  );
  const linkedDeviceSecretIds = matchedInstallations.map((row) => row.linked_device_secret_id);

  const revokedLinkedDeviceSecrets = await revokeDeviceSecretsByIds({
    adapter: input.adapter,
    ids: linkedDeviceSecretIds,
    reason,
  });

  const revokedInstallations = await revokeInstallationsByPredicate({
    adapter: input.adapter,
    predicate: installationPredicate,
    reason,
  });

  let revokedScopedDeviceSecrets = 0;
  try {
    const scopedSecretPredicate = buildDeviceSecretPredicate({
      scope,
      tenantId,
      sessionIds,
      userId,
      clientId,
      trustGroupId,
      allowScopeColumns: true,
    });
    revokedScopedDeviceSecrets = await revokeDeviceSecretsByPredicate({
      adapter: input.adapter,
      predicate: scopedSecretPredicate,
      reason,
    });
  } catch (error) {
    if (!isMissingDeviceSecretScopeColumnError(error)) {
      throw error;
    }
    const fallbackSecretPredicate = buildDeviceSecretPredicate({
      scope,
      tenantId,
      sessionIds,
      userId,
      clientId,
      trustGroupId,
      allowScopeColumns: false,
    });
    revokedScopedDeviceSecrets = await revokeDeviceSecretsByPredicate({
      adapter: input.adapter,
      predicate: fallbackSecretPredicate,
      reason,
    });
  }

  return {
    scope,
    tenantId,
    userId,
    clientId,
    trustGroupId,
    sessionIds,
    revokedDeviceSecrets: revokedLinkedDeviceSecrets + revokedScopedDeviceSecrets,
    revokedInstallations,
    matchedInstallations: matchedInstallations.length,
    callerAuthMode: input.callerAuthMode,
  };
}
