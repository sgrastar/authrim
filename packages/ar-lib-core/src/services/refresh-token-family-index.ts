import { ensureDatabaseAdapter, type DatabaseSource } from '../db';

export interface RefreshTokenFamilyIndexRow {
  jti: string;
  tenant_id: string;
  user_id: string;
  client_id: string;
  generation: number;
  expires_at: number;
  is_revoked: number;
}

export interface RefreshTokenFamilyGenerationStats {
  generation: number;
  total: number;
  active: number;
  revoked: number;
  expired: number;
}

function getAdapter(db: DatabaseSource) {
  return ensureDatabaseAdapter(db, 'refresh-token-family-index');
}

export async function recordRefreshTokenFamilyIndex(
  db: DatabaseSource,
  input: {
    jti: string;
    tenantId: string;
    userId: string;
    clientId: string;
    generation: number;
    expiresAt: number;
  }
): Promise<void> {
  const adapter = getAdapter(db);
  const existing = await adapter.queryOne<{ jti: string }>(
    'SELECT jti FROM user_token_families WHERE jti = ?',
    [input.jti]
  );
  if (existing) {
    return;
  }

  await adapter.execute(
    `INSERT INTO user_token_families (jti, tenant_id, user_id, client_id, generation, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.jti, input.tenantId, input.userId, input.clientId, input.generation, input.expiresAt]
  );
}

export async function listRefreshTokenFamiliesByUser(
  db: DatabaseSource,
  input: {
    tenantId: string;
    userId: string;
    clientId?: string | null;
    activeOnly?: boolean;
    nowMs?: number;
  }
): Promise<Array<Pick<RefreshTokenFamilyIndexRow, 'jti' | 'client_id' | 'generation'>>> {
  const adapter = getAdapter(db);
  const params: unknown[] = [input.userId, input.tenantId];
  const conditions = ['user_id = ?', 'tenant_id = ?'];

  if (input.clientId) {
    conditions.push('client_id = ?');
    params.push(input.clientId);
  }

  if (input.activeOnly) {
    conditions.push('is_revoked = 0');
    conditions.push('expires_at > ?');
    params.push(input.nowMs ?? Date.now());
  }

  return adapter.query<Pick<RefreshTokenFamilyIndexRow, 'jti' | 'client_id' | 'generation'>>(
    `SELECT jti, client_id, generation FROM user_token_families
     WHERE ${conditions.join(' AND ')}`,
    params
  );
}

export async function expireRefreshTokenFamiliesByUser(
  db: DatabaseSource,
  input: {
    tenantId: string;
    userId: string;
    clientId?: string | null;
  }
): Promise<number> {
  const adapter = getAdapter(db);
  const params: unknown[] = [input.userId, input.tenantId];
  let sql = `UPDATE user_token_families
             SET expires_at = 0
             WHERE user_id = ? AND tenant_id = ?`;

  if (input.clientId) {
    sql += ' AND client_id = ?';
    params.push(input.clientId);
  }

  const result = await adapter.execute(sql, params);
  return result.rowsAffected;
}

export async function revokeRefreshTokenFamiliesByUser(
  db: DatabaseSource,
  input: {
    tenantId: string;
    userId: string;
    clientId?: string | null;
  }
): Promise<number> {
  const adapter = getAdapter(db);
  const params: unknown[] = [input.userId, input.tenantId];
  let sql = `UPDATE user_token_families
             SET is_revoked = 1
             WHERE user_id = ? AND tenant_id = ?`;

  if (input.clientId) {
    sql += ' AND client_id = ?';
    params.push(input.clientId);
  }

  const result = await adapter.execute(sql, params);
  return result.rowsAffected;
}

export async function getRefreshTokenFamilyGenerationStats(
  db: DatabaseSource,
  input: {
    tenantId: string;
    clientId?: string | null;
    nowMs: number;
  }
): Promise<RefreshTokenFamilyGenerationStats[]> {
  const adapter = getAdapter(db);
  return adapter.query<RefreshTokenFamilyGenerationStats>(
    `SELECT
       generation,
       COUNT(*) as total,
       SUM(CASE WHEN is_revoked = 0 AND expires_at > ? THEN 1 ELSE 0 END) as active,
       SUM(CASE WHEN is_revoked = 1 THEN 1 ELSE 0 END) as revoked,
       SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) as expired
     FROM user_token_families
     WHERE tenant_id = ? AND (? IS NULL OR client_id = ?)
     GROUP BY generation
     ORDER BY generation DESC`,
    [input.nowMs, input.nowMs, input.tenantId, input.clientId ?? null, input.clientId ?? null]
  );
}

export async function countActiveRefreshTokenFamiliesByGeneration(
  db: DatabaseSource,
  input: {
    tenantId: string;
    generation: number;
    nowMs: number;
    clientId?: string | null;
  }
): Promise<number> {
  const adapter = getAdapter(db);
  const params: unknown[] = [input.tenantId, input.generation, input.nowMs];
  let sql = `SELECT COUNT(*) as count FROM user_token_families
             WHERE tenant_id = ? AND generation = ? AND is_revoked = 0 AND expires_at > ?`;

  if (input.clientId) {
    sql += ' AND client_id = ?';
    params.push(input.clientId);
  }

  const result = await adapter.queryOne<{ count: number }>(sql, params);
  return result?.count ?? 0;
}

export async function deleteRefreshTokenFamiliesByGeneration(
  db: DatabaseSource,
  input: {
    tenantId: string;
    generation: number;
    clientId?: string | null;
  }
): Promise<number> {
  const adapter = getAdapter(db);
  const params: unknown[] = [input.tenantId, input.generation];
  let sql = `DELETE FROM user_token_families
             WHERE tenant_id = ? AND generation = ?`;

  if (input.clientId) {
    sql += ' AND client_id = ?';
    params.push(input.clientId);
  }

  const result = await adapter.execute(sql, params);
  return result.rowsAffected;
}
